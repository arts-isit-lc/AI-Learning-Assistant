"""ImageEscalation fetches images from S3 and invokes vision LLM for analysis.

Classification is handled by QueryAnalyzer (requires_escalation field).
This module only handles execution: S3 fetch + vision LLM call.
"""

from __future__ import annotations

import base64
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import (
    CrossModalFamily,
    ElementType,
    GroundedArtifact,
    GroundingResolution,
    ImageAnalysis,
    RankedResult,
    ResolutionConfidence,
    ResolvedReference,
    VisionAnalysis,
    VisionMode,
)
from .reference_lookup import build_reference_regex, scope_predicate

logger = Logger(service="multimodal-rag-reasoning")

# Vision model IDs are injected as Lambda env vars from cdk/lib/constants/bedrock.ts
# (single source of truth); the defaults keep local/unit runs working without env.
# Single-image escalation uses Haiku 4.5; the multi-image comparison call uses the
# stronger Sonnet 4.5 (COMPARISON_VISION_MODEL_ID). Both route via Geo-US CRIS.
VISION_MODEL_ID = os.environ.get(
    "VISION_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0"
)
COMPARISON_VISION_MODEL_ID = os.environ.get(
    "COMPARISON_VISION_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
)

# Max images to vision-analyze per escalation. Kept at 2 so a generic two-image
# request ("compare the two diagrams") still works; the calls run in PARALLEL
# (see _analyze_images), so 2 images cost ~the wall time of 1 rather than double.
# Env-tunable: set to 1 to disable the second call.
_MAX_ESCALATION_IMAGES = int(os.environ.get("ESCALATION_MAX_IMAGES", "2"))

# Cross-modal grounding co-presents ONE structured reference + ONE image in a
# single vision call. v1 caps the image side at 1 (the model is N-way-ready).
_MAX_GROUNDING_IMAGES = 1
# Character budget for a rendered structured reference in a grounding call — keeps
# the vision payload bounded (table rows are already capped at 50 in metadata).
_GROUNDING_RENDER_CHAR_BUDGET = int(os.environ.get("GROUNDING_RENDER_CHAR_BUDGET", "6000"))
_GROUNDING_MAX_ROWS = 50


def render_artifact(artifact: GroundedArtifact) -> str:
    """Render a GroundedArtifact's ``structured_content`` into vision-call text.

    This is the ONE place artifact type matters (the vision layer's message
    builder + prompt never branch on type). v1 has a production TABLE branch; all
    other types fall to a PLUMBING-ONLY generic dump that exists purely so a
    not-yet-specialized type can traverse the pipeline (the abstraction test). A
    type is "supported" only once it has a real branch here — do NOT conclude a
    type works because it renders via the fallback.
    """
    if artifact.artifact_type == ElementType.TABLE:
        return _render_table_block(artifact.structured_content or {})
    return _render_generic_fallback(artifact.structured_content or {})


def _render_table_block(content: dict) -> str:
    """Render a table's {headers, rows, summary, content} as bounded readable text."""
    headers = content.get("headers") or []
    rows = content.get("rows") or []
    summary = content.get("summary") or ""

    parts: list[str] = []
    if summary:
        parts.append(str(summary))
    truncated = False
    if headers:
        header_line = " | ".join(str(h) for h in headers)
        parts.append(header_line)
        parts.append("-" * min(len(header_line), 80))
    shown_rows = rows[:_GROUNDING_MAX_ROWS]
    if len(rows) > _GROUNDING_MAX_ROWS:
        truncated = True
    for row in shown_rows:
        parts.append(" | ".join("" if cell is None else str(cell) for cell in row))

    text = "\n".join(parts).strip()
    if not text:
        # No parsed headers/rows/summary — fall back to any raw table text.
        text = str(content.get("content") or "")

    if len(text) > _GROUNDING_RENDER_CHAR_BUDGET:
        text = text[:_GROUNDING_RENDER_CHAR_BUDGET].rstrip()
        truncated = True
    if truncated:
        text += "\n[table truncated — ground only the rows shown above]"
    return text


def _render_generic_fallback(content: dict) -> str:
    """PLUMBING-ONLY renderer (NOT production quality).

    A readable key/value dump so a not-yet-specialized artifact type can flow
    through the grounding pipeline for the abstraction test. Never ship a type on
    this — give it a real branch in ``render_artifact`` first.
    """
    text = "\n".join(f"{k}: {v}" for k, v in (content or {}).items())
    if len(text) > _GROUNDING_RENDER_CHAR_BUDGET:
        text = text[:_GROUNDING_RENDER_CHAR_BUDGET].rstrip()
    return text


@dataclass
class EscalationResult:
    """Result of image escalation processing.

    ``image_analyses`` carries the SINGLE-image path output and is UNCHANGED in v1.
    The multi-image path instead sets ``vision_analysis`` (one MULTI product over
    >= 2 co-presented figures). The two are mutually exclusive per escalation.
    """

    escalation_used: bool
    image_analyses: list[ImageAnalysis] = field(default_factory=list)
    vision_analysis: VisionAnalysis | None = None


class ImageEscalation:
    """Fetches images from S3 and invokes vision LLM for detailed analysis.

    Accepts s3_client and bedrock_client via constructor for dependency injection
    and testability.

    Error handling:
    - S3 fetch failure -> skip that image, log, continue with next
    - Vision LLM failure -> skip that image, log, continue with next
    - Never raises unhandled exceptions to caller
    """

    def __init__(
        self,
        s3_client: Any = None,
        bedrock_client: Any = None,
        bucket_name: str = "",
        db_connection_factory: Any = None,
    ) -> None:
        """Initialize ImageEscalation with AWS clients.

        Args:
            s3_client: Boto3 S3 client (injected for testing).
            bedrock_client: Boto3 Bedrock Runtime client (injected for testing).
            bucket_name: S3 bucket name where images are stored.
            db_connection_factory: Callable that returns a psycopg2 connection for direct DB lookups.
        """
        self.s3_client = s3_client
        self.bedrock_client = bedrock_client
        self.bucket_name = bucket_name
        self._db_connection_factory = db_connection_factory

    def escalate(
        self,
        results: list[RankedResult],
        query: str,
        query_intent=None,
        scope_filter: dict | None = None,
    ) -> EscalationResult:
        """Perform image escalation on ranked results.

        When a figure_reference is present in query_intent, prefers images that
        are siblings of text results containing matching figure captions.
        Falls back to top-scoring images when no sibling link exists.

        Args:
            results: Ranked results from the retrieval layer.
            query: The user's original query for vision analysis context.
            query_intent: Optional QueryIntent with figure_reference for targeted lookup.
            scope_filter: Optional file/module scope (e.g. {"file_id": [...]} or
                {"module_id": "..."}) applied to the direct DB figure lookup so it
                cannot match figures from other files/modules. Strategies that read
                from `results` are already scoped by the upstream search.

        Returns:
            EscalationResult with escalation_used flag and image analyses.
        """
        escalation_start = time.time()
        image_results_count = sum(1 for r in results if r.image_s3_key is not None)

        logger.info(
            "Starting image escalation",
            extra={
                "total_results": len(results),
                "image_results_available": image_results_count,
                "has_figure_reference": query_intent is not None and getattr(query_intent, "figure_reference", None) is not None,
                "query_preview": query[:80],
            },
        )

        try:
            # Strategy 0 (multi-image): >= 2 distinct references -> resolve each and
            # co-present ALL of them in ONE vision call (Sonnet 4.5). Additive; the
            # SINGLE-image strategies below are untouched.
            if getattr(query_intent, "requires_multi_image", False):
                multi = self._escalate_multi_image(results, query, query_intent, scope_filter)
                if multi is not None:
                    va = multi.vision_analysis
                    logger.info(
                        "Escalation complete via multi-image strategy",
                        extra={
                            "prompt_intent": va.prompt_intent if va else None,
                            "references_requested": len(getattr(query_intent, "figure_references", []) or []),
                            "references_resolved": len(va.reference_mapping) if va else 0,
                            "escalation_latency_ms": round((time.time() - escalation_start) * 1000, 2),
                        },
                    )
                    return multi
                logger.info(
                    "Multi-image escalation resolved nothing; falling back to standard strategies"
                )

            # Strategy 1: If figure_reference is set, find sibling-linked images
            if query_intent is not None and query_intent.figure_reference is not None:
                logger.info(
                    "Attempting sibling-linked image strategy",
                    extra={
                        "figure_ref_type": query_intent.figure_reference.ref_type,
                        "figure_ref_number": query_intent.figure_reference.number,
                    },
                )
                sibling_images = self._find_sibling_linked_images(
                    results, query_intent.figure_reference.number
                )
                if sibling_images:
                    analyses = self._analyze_images(
                        sibling_images[:_MAX_ESCALATION_IMAGES], query
                    )
                    if analyses:
                        escalation_latency = time.time() - escalation_start
                        logger.info(
                            "Escalation complete via sibling-linked strategy",
                            extra={
                                "analyses_produced": len(analyses),
                                "sibling_images_found": len(sibling_images),
                                "escalation_latency_ms": round(escalation_latency * 1000, 2),
                            },
                        )
                        return EscalationResult(escalation_used=True, image_analyses=analyses)
                else:
                    logger.info("No sibling-linked images found, falling back to score-based strategy")

            # Strategy 1.5: Direct DB lookup for the figure's image by figure_ref metadata
            if query_intent is not None and query_intent.figure_reference is not None and self._db_connection_factory:
                db_image = self._find_image_by_figure_ref_in_db(
                    query_intent.figure_reference.ref_type,
                    query_intent.figure_reference.number,
                    scope_filter=scope_filter,
                )
                if db_image is not None:
                    analysis = self._analyze_image(db_image, query)
                    if analysis is not None:
                        escalation_latency = time.time() - escalation_start
                        logger.info(
                            "Escalation complete via direct DB lookup",
                            extra={
                                "analyses_produced": 1,
                                "retrieval_id": db_image.retrieval_id,
                                "escalation_latency_ms": round(escalation_latency * 1000, 2),
                            },
                        )
                        return EscalationResult(escalation_used=True, image_analyses=[analysis])

            # Strategy 2: Fallback to top-scoring image results by image_s3_key
            image_results = [r for r in results if r.image_s3_key is not None]

            if not image_results:
                escalation_latency = time.time() - escalation_start
                logger.info(
                    "No image results available for escalation",
                    extra={"escalation_latency_ms": round(escalation_latency * 1000, 2)},
                )
                return EscalationResult(escalation_used=False, image_analyses=[])

            # Select top N by score (descending)
            sorted_results = sorted(
                image_results, key=lambda r: r.score, reverse=True
            )
            top_results = sorted_results[:_MAX_ESCALATION_IMAGES]

            logger.info(
                "Using score-based image selection",
                extra={
                    "top_image_scores": [round(r.score, 4) for r in top_results],
                    "top_image_keys": [r.image_s3_key for r in top_results],
                },
            )

            analyses = self._analyze_images(top_results, query)

            escalation_latency = time.time() - escalation_start

            if analyses:
                logger.info(
                    "Escalation complete via score-based strategy",
                    extra={
                        "analyses_produced": len(analyses),
                        "escalation_latency_ms": round(escalation_latency * 1000, 2),
                    },
                )
                return EscalationResult(
                    escalation_used=True, image_analyses=analyses
                )
            else:
                logger.warning(
                    "Escalation attempted but no analyses produced",
                    extra={
                        "images_attempted": len(top_results),
                        "escalation_latency_ms": round(escalation_latency * 1000, 2),
                    },
                )
                return EscalationResult(
                    escalation_used=False, image_analyses=[]
                )

        except Exception:
            logger.exception("Unexpected error during image escalation")
            return EscalationResult(escalation_used=False, image_analyses=[])

    def _find_sibling_linked_images(
        self, results: list[RankedResult], figure_number: str
    ) -> list[RankedResult]:
        """Find image results that are siblings of text chunks with a matching figure reference.

        First checks within ranked results for matching captions and their sibling images.
        If no sibling image is found in results, constructs a synthetic RankedResult
        from the sibling_ids metadata so the image can still be fetched from S3.

        Args:
            results: All ranked results from retrieval.
            figure_number: The figure number to match (e.g., "1.1").

        Returns:
            List of image RankedResults linked as siblings to the matching caption.
        """
        # Find text results with matching figure_ref in metadata
        matching_text_results = []
        for r in results:
            fig_ref = r.metadata.get("figure_ref", "")
            if figure_number in fig_ref:
                matching_text_results.append(r)

        if not matching_text_results:
            return []

        # Collect sibling_ids from matching text results
        sibling_ids: set[str] = set()
        for text_result in matching_text_results:
            sibling_ids.update(text_result.sibling_ids)

        if not sibling_ids:
            return []

        # First: check if any sibling images are already in the results
        sibling_images = [
            r for r in results
            if r.retrieval_id in sibling_ids and r.image_s3_key is not None
        ]

        if sibling_images:
            return sibling_images

        # Second: look for image results in results that match the sibling IDs
        # (they might be present but without image_s3_key populated in the RankedResult)
        for r in results:
            if r.retrieval_id in sibling_ids and r.element_type.value == "image":
                # Try getting image_s3_key from metadata
                s3_key = r.metadata.get("image_s3_key")
                if s3_key:
                    r.image_s3_key = s3_key
                    sibling_images.append(r)

        if sibling_images:
            return sibling_images

        # Third: construct synthetic RankedResult for siblings not in results
        # This handles the case where sibling expansion pulled the image into context
        # but the image wasn't in the original ranked results
        from ..models.data_models import ElementType
        for sid in sibling_ids:
            # Check all results for any element that has this as a sibling
            for r in results:
                if r.element_type == ElementType.IMAGE and r.retrieval_id == sid:
                    sibling_images.append(r)

        # If still nothing, create a minimal RankedResult from the metadata we have
        if not sibling_images:
            for text_result in matching_text_results:
                for sid in text_result.sibling_ids:
                    # Find the image s3 key from any result's metadata that references this sibling
                    # As a last resort, construct from the text result's page info
                    from ..models.data_models import RankedResult as RR
                    # We know the sibling exists in DB — create a minimal result with its s3_key
                    # The _analyze_image method only needs image_s3_key to fetch from S3
                    page_num = text_result.metadata.get("provenance_page_num", 0)
                    # Look through ALL results for an image on the same page
                    for r in results:
                        if (r.element_type == ElementType.IMAGE
                                and r.metadata.get("provenance_page_num") == page_num):
                            if r.image_s3_key:
                                sibling_images.append(r)
                                break

        return sibling_images

    @staticmethod
    def _scope_predicate(scope_filter: dict | None) -> tuple[str, list]:
        """Render a file/module scope filter into an AND SQL fragment + params.

        Thin delegate to the shared ``reference_lookup.scope_predicate`` so the
        image and table paths use one implementation. Kept as a static method
        for backwards compatibility with existing callers/tests.
        """
        return scope_predicate(scope_filter)

    @staticmethod
    def _build_reference_regex(ref_type: str, number: str) -> str:
        """Build a POSIX regex matching an EXACT figure/table reference (M11).

        Thin delegate to the shared ``reference_lookup.build_reference_regex``
        so the image and table paths use one implementation. Kept as a static
        method for backwards compatibility with existing callers/tests.
        """
        return build_reference_regex(ref_type, number)

    def _find_image_by_figure_ref_in_db(
        self, ref_type: str, number: str, scope_filter: dict | None = None
    ) -> RankedResult | None:
        """Query the database directly for an image linked to a figure reference.

        This bypasses the ranked results and finds the image by:
        1. Looking for a text retrieval unit with matching figure_ref metadata
        2. Getting its sibling image via sibling_ids
        3. Constructing a RankedResult for the image

        Args:
            ref_type: Type of reference ("figure", "table", "algorithm").
            number: The number (e.g., "1.1").
            scope_filter: Optional file/module scope restricting the lookup to
                the caller's allowed files (same dict the main search used).

        Returns:
            RankedResult for the image if found, None otherwise.
        """
        if self._db_connection_factory is None:
            return None

        try:
            import json as _json
            conn = self._db_connection_factory()
            if conn is None:
                return None

            cur = conn.cursor()
            scope_sql, scope_params = self._scope_predicate(scope_filter)

            # Strategy A: Find image directly by matching embedding_text.
            # M11: exact reference match. A bare LIKE '%figure 4%' also matches
            # "Figure 4.1 / 40 / 24"; anchor the number with non-digit/non-dot
            # boundaries via a POSIX regex so "figure 4" != "figure 4.1".
            ref_regex = self._build_reference_regex(ref_type, number)
            # ORDER BY retrieval_id makes the single-pick deterministic when several
            # in-scope images match the same reference number (R12).
            cur.execute(f"""
                SELECT retrieval_id, embedding_text, metadata
                FROM retrieval_units
                WHERE element_type = 'image'
                AND embedding_text ~* %s{scope_sql}
                ORDER BY retrieval_id
                LIMIT 1;
            """, (ref_regex, *scope_params))

            row = cur.fetchone()
            if row:
                metadata = row[2] if isinstance(row[2], dict) else (_json.loads(row[2]) if row[2] else {})
                cur.close()
                from ..models.data_models import ElementType
                logger.info(
                    "Found image via direct DB lookup (embedding_text match)",
                    extra={"retrieval_id": row[0], "ref_type": ref_type, "number": number},
                )
                return RankedResult(
                    retrieval_id=row[0],
                    parent_element_id="",
                    content=row[1],
                    element_type=ElementType.IMAGE,
                    score=1.0,
                    cross_encoder_score=0.0,
                    metadata_boost=0.0,
                    metadata=metadata,
                    image_s3_key=metadata.get("image_s3_key"),
                    sibling_ids=[],
                )

            # Strategy B: Find text caption with figure_ref, then get sibling image
            figure_ref_value = f"{ref_type} {number}"
            cur.execute(f"""
                SELECT sibling_ids
                FROM retrieval_units
                WHERE metadata->>'figure_ref' ILIKE %s{scope_sql}
                LIMIT 1;
            """, (figure_ref_value, *scope_params))

            row = cur.fetchone()
            if row:
                sibling_ids = row[0] if isinstance(row[0], list) else (_json.loads(row[0]) if row[0] else [])
                if sibling_ids:
                    placeholders = ",".join(["%s"] * len(sibling_ids))
                    cur.execute(f"""
                        SELECT retrieval_id, embedding_text, metadata
                        FROM retrieval_units
                        WHERE retrieval_id IN ({placeholders})
                        AND element_type = 'image'
                        LIMIT 1;
                    """, sibling_ids)

                    img_row = cur.fetchone()
                    if img_row:
                        metadata = img_row[2] if isinstance(img_row[2], dict) else (_json.loads(img_row[2]) if img_row[2] else {})
                        cur.close()
                        from ..models.data_models import ElementType
                        logger.info(
                            "Found image via direct DB lookup (sibling of figure_ref caption)",
                            extra={"retrieval_id": img_row[0], "ref_type": ref_type, "number": number},
                        )
                        return RankedResult(
                            retrieval_id=img_row[0],
                            parent_element_id="",
                            content=img_row[1],
                            element_type=ElementType.IMAGE,
                            score=1.0,
                            cross_encoder_score=0.0,
                            metadata_boost=0.0,
                            metadata=metadata,
                            image_s3_key=metadata.get("image_s3_key"),
                            sibling_ids=[],
                        )

            # Strategy C: For tables — find the table's page and look for a page-render image
            if ref_type == "table":
                cur.execute(f"""
                    SELECT metadata->>'provenance_page_num' as page_num
                    FROM retrieval_units
                    WHERE element_type = 'table'
                    AND embedding_text ~* %s{scope_sql}
                    LIMIT 1;
                """, (ref_regex, *scope_params))

                row = cur.fetchone()
                if row and row[0]:
                    page_num = row[0]
                    # Look for a page-render image on the same page
                    cur.execute(f"""
                        SELECT retrieval_id, embedding_text, metadata
                        FROM retrieval_units
                        WHERE element_type = 'image'
                        AND metadata->>'provenance_page_num' = %s
                        AND metadata->>'image_s3_key' IS NOT NULL{scope_sql}
                        ORDER BY
                            CASE WHEN metadata->>'render_reason' = 'vector_graphics_detected' THEN 0 ELSE 1 END
                        LIMIT 1;
                    """, (page_num, *scope_params))

                    img_row = cur.fetchone()
                    if img_row:
                        metadata = img_row[2] if isinstance(img_row[2], dict) else (_json.loads(img_row[2]) if img_row[2] else {})
                        cur.close()
                        from ..models.data_models import ElementType
                        logger.info(
                            "Found page-render image for table reference",
                            extra={"retrieval_id": img_row[0], "ref_type": ref_type, "number": number, "page_num": page_num},
                        )
                        return RankedResult(
                            retrieval_id=img_row[0],
                            parent_element_id="",
                            content=img_row[1],
                            element_type=ElementType.IMAGE,
                            score=1.0,
                            cross_encoder_score=0.0,
                            metadata_boost=0.0,
                            metadata=metadata,
                            image_s3_key=metadata.get("image_s3_key"),
                            sibling_ids=[],
                        )

            cur.close()
            logger.info(
                "Direct DB lookup found no image for figure reference",
                extra={"ref_type": ref_type, "number": number},
            )
            return None

        except Exception:
            logger.exception("Error during direct DB lookup for figure reference")
            return None

    def _analyze_images(
        self, image_results: list[RankedResult], query: str
    ) -> list[ImageAnalysis]:
        """Vision-analyze up to N images CONCURRENTLY, preserving input order.

        The selected images are analyzed in parallel (bounded ThreadPoolExecutor)
        so two vision calls cost ~the wall time of one instead of their sum — the
        main escalation latency win. Results keep the caller's order (so the
        primary/top image stays first for grounding); failed analyses (None) are
        dropped. boto3 S3/Bedrock clients are thread-safe and _analyze_image
        shares no mutable state, so this is safe to run concurrently.
        """
        if not image_results:
            return []

        # Single image: no thread overhead.
        if len(image_results) == 1:
            analysis = self._analyze_image(image_results[0], query)
            return [analysis] if analysis is not None else []

        ordered: list[ImageAnalysis | None] = [None] * len(image_results)
        with ThreadPoolExecutor(max_workers=len(image_results)) as executor:
            future_to_index = {
                executor.submit(self._analyze_image, img, query): i
                for i, img in enumerate(image_results)
            }
            for future in future_to_index:
                index = future_to_index[future]
                try:
                    ordered[index] = future.result()
                except Exception:
                    logger.exception(
                        "Parallel image analysis failed for one image, skipping",
                        extra={"image_index": index},
                    )
                    ordered[index] = None

        return [a for a in ordered if a is not None]

    def _analyze_image(
        self, result: RankedResult, query: str
    ) -> ImageAnalysis | None:
        """Fetch an image from S3 and invoke vision LLM analysis.

        Args:
            result: A ranked result with a non-null image_s3_key.
            query: The user's query for context.

        Returns:
            ImageAnalysis if successful, None if any step fails.
        """
        image_s3_key = result.image_s3_key
        if image_s3_key is None:
            return None

        analyze_start = time.time()

        # Step 1: Fetch image from S3
        fetch_start = time.time()
        image_bytes = self._fetch_image(image_s3_key)
        fetch_latency = time.time() - fetch_start

        if image_bytes is None:
            return None

        logger.info(
            "Image fetched from S3",
            extra={
                "image_s3_key": image_s3_key,
                "image_size_bytes": len(image_bytes),
                "fetch_latency_ms": round(fetch_latency * 1000, 2),
            },
        )

        # Step 2: Invoke vision LLM
        llm_start = time.time()
        analysis = self._invoke_vision_llm(image_bytes, image_s3_key, query)
        llm_latency = time.time() - llm_start

        if analysis is not None:
            logger.info(
                "Vision LLM analysis complete",
                extra={
                    "image_s3_key": image_s3_key,
                    "analysis_length": len(analysis.analysis),
                    "confidence": analysis.confidence,
                    "llm_latency_ms": round(llm_latency * 1000, 2),
                    "total_analyze_latency_ms": round((time.time() - analyze_start) * 1000, 2),
                },
            )

        return analysis

    def _fetch_image(self, image_s3_key: str) -> bytes | None:
        """Fetch image bytes from S3.

        Args:
            image_s3_key: The S3 object key or full s3:// URI for the image.

        Returns:
            Image bytes if successful, None on failure.
        """
        try:
            # Handle full s3:// URI format: s3://bucket-name/key
            key = image_s3_key
            bucket = self.bucket_name
            if key.startswith("s3://"):
                # Parse s3://bucket/key format
                without_prefix = key[5:]  # remove "s3://"
                parts = without_prefix.split("/", 1)
                if len(parts) == 2:
                    bucket = parts[0]
                    key = parts[1]

            response = self.s3_client.get_object(Bucket=bucket, Key=key)
            return response["Body"].read()
        except Exception:
            logger.exception(
                "Failed to fetch image from S3",
                extra={"image_s3_key": image_s3_key, "bucket": bucket},
            )
            return None

    def _invoke_vision_llm(
        self, image_bytes: bytes, image_s3_key: str, query: str
    ) -> ImageAnalysis | None:
        """Invoke Claude 3 Haiku vision model for image analysis.

        Args:
            image_bytes: Raw image bytes fetched from S3.
            image_s3_key: The S3 key (for result attribution).
            query: The user's query for analysis context.

        Returns:
            ImageAnalysis if successful, None on failure.
        """
        try:
            import json

            image_base64 = base64.b64encode(image_bytes).decode("utf-8")

            # Determine media type from key extension
            media_type = self._get_media_type(image_s3_key)

            body = json.dumps(
                {
                    "anthropic_version": "bedrock-2023-05-31",
                    "max_tokens": 1024,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": media_type,
                                        "data": image_base64,
                                    },
                                },
                                {
                                    "type": "text",
                                    "text": (
                                        f"Analyze this image in the context of the following question: {query}\n\n"
                                        "Provide a detailed description of what this image shows and how it "
                                        "relates to the question. Include any relevant labels, data points, "
                                        "or concepts visible in the image."
                                    ),
                                },
                            ],
                        }
                    ],
                }
            )

            response = self.bedrock_client.invoke_model(
                modelId=VISION_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=body,
            )

            response_body = json.loads(response["body"].read())
            analysis_text = response_body["content"][0]["text"]

            # Extract confidence from stop_reason (full response = high confidence)
            stop_reason = response_body.get("stop_reason", "end_turn")
            confidence = 0.9 if stop_reason == "end_turn" else 0.7

            return ImageAnalysis(
                image_s3_key=image_s3_key,
                analysis=analysis_text,
                confidence=confidence,
            )

        except Exception:
            logger.exception(
                "Failed to invoke vision LLM",
                extra={"image_s3_key": image_s3_key},
            )
            return None

    @staticmethod
    def _get_media_type(image_s3_key: str) -> str:
        """Determine media type from file extension.

        Args:
            image_s3_key: S3 object key.

        Returns:
            MIME type string for the image.
        """
        key_lower = image_s3_key.lower()
        if key_lower.endswith(".png"):
            return "image/png"
        elif key_lower.endswith(".gif"):
            return "image/gif"
        elif key_lower.endswith(".webp"):
            return "image/webp"
        elif key_lower.endswith((".jpg", ".jpeg")):
            return "image/jpeg"
        elif key_lower.endswith(".tiff") or key_lower.endswith(".tif"):
            return "image/tiff"
        elif key_lower.endswith(".bmp"):
            return "image/bmp"
        else:
            # Default to png for unknown extensions
            return "image/png"

    # -----------------------------------------------------------------------
    # Cross-modal (ONE structured reference + ONE image in ONE call).
    # ``family`` (GROUNDING / EXPLANATION) selects the prompt — the ONLY thing that
    # differs; the execution mode (VisionMode.CROSS_MODAL) is shared.
    # -----------------------------------------------------------------------

    def escalate_cross_modal(
        self,
        results: list[RankedResult],
        query: str,
        table_resolution: GroundingResolution,
        family: CrossModalFamily,
        query_intent: Any = None,
        scope_filter: dict | None = None,
    ) -> EscalationResult:
        """Co-present ONE structured reference + ONE image in a single Sonnet 4.5 call.

        ``family`` selects the prompt family (GROUNDING = place the reference's
        entries onto the image; EXPLANATION = interpret how they relate) — the ONLY
        difference between the two; the execution mode (``VisionMode.CROSS_MODAL``)
        and everything structural are shared. The reference is already resolved (by
        the reasoning engine) into ``table_resolution``; this resolves the IMAGE,
        fetches its bytes, and issues one vision call that receives only the PURE
        ``GroundedArtifact`` — retrieval state never reaches the vision layer.

        Returns ``escalation_used=False`` (so the caller degrades gracefully to the
        normal escalation/text path) when no image resolves or the vision call
        fails. Never raises.
        """
        start = time.time()
        try:
            image, image_conf = self._resolve_grounding_image(
                results, query_intent, scope_filter
            )
            if image is None or not image.image_s3_key:
                logger.info(
                    "Cross-modal call: no image resolved; caller falls back",
                    extra={"family": family.value, "artifact_label": table_resolution.artifact.label},
                )
                return EscalationResult(escalation_used=False)

            image_bytes = self._fetch_image(image.image_s3_key)
            if image_bytes is None:
                return EscalationResult(escalation_used=False)

            low_confidence = (
                table_resolution.confidence == ResolutionConfidence.LOW
                or image_conf == ResolutionConfidence.LOW
            )

            analysis_text, vision_confidence = self._invoke_vision_llm_cross_modal(
                image_bytes,
                image.image_s3_key,
                table_resolution.artifact,
                query,
                family=family,
                low_confidence=low_confidence,
            )
            if analysis_text is None:
                return EscalationResult(escalation_used=False)

            image_ref = ResolvedReference(
                reference=self._grounding_image_label(query_intent),
                retrieval_id=image.retrieval_id,
                image_s3_key=image.image_s3_key,
                confidence=image_conf,
            )
            logger.info(
                "Cross-modal call complete",
                extra={
                    "family": family.value,
                    "artifact_label": table_resolution.artifact.label,
                    "artifact_type": table_resolution.artifact.artifact_type.value,
                    "image_retrieval_id": image.retrieval_id,
                    "low_confidence": low_confidence,
                    "latency_ms": round((time.time() - start) * 1000, 2),
                },
            )
            return EscalationResult(
                escalation_used=True,
                vision_analysis=VisionAnalysis(
                    mode=VisionMode.CROSS_MODAL,
                    analysis=analysis_text,
                    confidence=vision_confidence,
                    resolved_images=[image],
                    reference_mapping=[image_ref],
                    cross_modal_family=family,
                    resolved_artifacts=[table_resolution],
                ),
            )
        except Exception:
            logger.exception("Unexpected error during cross-modal call")
            return EscalationResult(escalation_used=False)

    def escalate_cross_modal_grounding(
        self,
        results: list[RankedResult],
        query: str,
        table_resolution: GroundingResolution,
        query_intent: Any = None,
        scope_filter: dict | None = None,
    ) -> EscalationResult:
        """Grounding wrapper over the generalized path (unchanged public API)."""
        return self.escalate_cross_modal(
            results,
            query,
            table_resolution,
            family=CrossModalFamily.GROUNDING,
            query_intent=query_intent,
            scope_filter=scope_filter,
        )

    def _resolve_grounding_image(
        self,
        results: list[RankedResult],
        query_intent: Any,
        scope_filter: dict | None,
    ) -> tuple[RankedResult | None, ResolutionConfidence]:
        """Resolve the single image for a grounding call.

        Prefers a resolved FIGURE reference (scoped, deterministic, + confidence,
        reusing ``_resolve_figure_image``); otherwise falls back to the top-scoring
        image already retrieved for the query (a relevance pick -> MEDIUM). Table
        references in ``figure_references`` are ignored here — they are the reference
        side, not the image.
        """
        figure_refs = [
            r
            for r in (getattr(query_intent, "figure_references", None) or [])
            if getattr(r, "ref_type", None) == "figure"
        ]
        for ref in figure_refs[:_MAX_GROUNDING_IMAGES]:
            image, confidence = self._resolve_figure_image(
                ref, results, scope_filter=scope_filter
            )
            if image is not None and image.image_s3_key:
                return image, confidence

        image_results = [r for r in results if r.image_s3_key is not None]
        if image_results:
            top = sorted(image_results, key=lambda r: r.score, reverse=True)[0]
            return top, ResolutionConfidence.MEDIUM
        return None, ResolutionConfidence.LOW

    @staticmethod
    def _grounding_image_label(query_intent: Any) -> str:
        """Human label for the grounded image (a figure ref if named, else generic)."""
        for r in getattr(query_intent, "figure_references", None) or []:
            if getattr(r, "ref_type", None) == "figure":
                return f"{r.ref_type.title()} {r.number}"
        return "the image"

    def _invoke_vision_llm_cross_modal(
        self,
        image_bytes: bytes,
        image_s3_key: str,
        artifact: GroundedArtifact,
        query: str,
        family: CrossModalFamily,
        low_confidence: bool = False,
    ) -> tuple[str | None, float]:
        """Invoke the cross-modal vision model (Sonnet 4.5) with reference text + image.

        Builds ONE message: a labeled text block carrying the rendered reference, then
        the image block, then the family-selected prompt (``_cross_modal_prompt``).
        Consumes only the PURE ``GroundedArtifact`` (principle 2.5). Returns
        ``(analysis_text, confidence)``; ``(None, 0.0)`` on any failure.
        """
        try:
            import json

            artifact_label = artifact.label or artifact.artifact_type.value.title()
            content: list[dict] = [
                {"type": "text", "text": f"{artifact.artifact_type.value.upper()} — {artifact_label}:"},
                {"type": "text", "text": render_artifact(artifact)},
                {"type": "text", "text": "Image:"},
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": self._get_media_type(image_s3_key),
                        "data": base64.b64encode(image_bytes).decode("utf-8"),
                    },
                },
                {"type": "text", "text": self._cross_modal_prompt(query, artifact, family, low_confidence)},
            ]

            response = self.bedrock_client.invoke_model(
                modelId=COMPARISON_VISION_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(
                    {
                        "anthropic_version": "bedrock-2023-05-31",
                        "max_tokens": 1500,
                        "messages": [{"role": "user", "content": content}],
                    }
                ),
            )
            response_body = json.loads(response["body"].read())
            analysis_text = response_body["content"][0]["text"]
            stop_reason = response_body.get("stop_reason", "end_turn")
            confidence = 0.9 if stop_reason == "end_turn" else 0.7
            logger.info(
                "Cross-modal vision analysis complete",
                extra={
                    "model_id": COMPARISON_VISION_MODEL_ID,
                    "family": family.value,
                    "artifact_type": artifact.artifact_type.value,
                    "analysis_length": len(analysis_text),
                },
            )
            return analysis_text, confidence
        except Exception:
            logger.exception(
                "Failed to invoke cross-modal vision LLM",
                extra={"image_s3_key": image_s3_key},
            )
            return None, 0.0

    @staticmethod
    def _cross_modal_prompt(
        query: str, artifact: GroundedArtifact, family: CrossModalFamily, low_confidence: bool = False
    ) -> str:
        """Dispatch to the family's prompt. The ONE place the prompt family matters."""
        if family == CrossModalFamily.EXPLANATION:
            return ImageEscalation._explanation_prompt(query, artifact, low_confidence)
        return ImageEscalation._grounding_prompt(query, artifact, low_confidence)

    @staticmethod
    def _grounding_prompt(query: str, artifact: GroundedArtifact, low_confidence: bool = False) -> str:
        """Build the trailing grounding instruction (reference-generic, example-led).

        Leads with a concrete example ("such as a table") so the model grounds the
        abstraction, then constrains it to visible content only (no invented
        coordinates) and to declaring un-locatable entries rather than guessing.
        """
        type_word = artifact.artifact_type.value
        header = (
            "You are helping a student use a structured reference (such as a table) together with an "
            "image from their course materials.\n"
            f'Above you are given: (1) a structured reference (a {type_word}, "{artifact.label}"), and '
            "(2) an image, each labeled.\n\n"
            f'The student asked: "{query}"\n\n'
        )
        body = (
            "Ground the reference onto the image:\n"
            "1. Briefly state what the image shows (axes, legend, labeled regions/points) and what the "
            "reference contains.\n"
            "2. For each relevant entry in the reference (e.g. each table row), identify where it maps on "
            "the image — a region, marker, axis position, or label — using ONLY what is visibly present "
            "in the image and the reference's content.\n"
            "3. If an entry cannot be located on the image (no matching label/legend/axis), say so "
            "explicitly for that entry.\n"
            "4. Give a direct, justified answer to the student's question, based only on the reference "
            "content and visible image content.\n\n"
            "Constraints:\n"
            "- Use ONLY the provided reference content and what is actually visible in the image.\n"
            "- Do NOT invent coordinates, positions, or labels the image does not show.\n"
            "- If the image lacks the labels/legend/axes needed to place the data, state that rather "
            "than guessing.\n"
            "- The reference may be truncated (large tables); if so, ground only the entries shown."
        )
        note = ""
        if low_confidence:
            note = (
                "\n- The reference or image may not be the one the student intended; note this and "
                "invite them to confirm which they meant."
            )
        return header + body + note

    @staticmethod
    def _explanation_prompt(query: str, artifact: GroundedArtifact, low_confidence: bool = False) -> str:
        """Build the EXPLANATION prompt — interpret how the reference and image relate.

        Structured 4-part output (what the reference has / what the image shows / the
        relationship / answer the question) for consistency, and faithfulness-hardened:
        it forbids inventing numbers/labels/colors/curves and requires admitting when
        the relationship cannot be determined — directly targeting the observed
        hallucination failure.
        """
        type_word = artifact.artifact_type.value
        header = (
            "You are helping a student understand how a structured reference (such as a table) and an "
            "image from their course materials RELATE to each other.\n"
            f'Above you are given: (1) a structured reference (a {type_word}, "{artifact.label}"), and '
            "(2) an image, each labeled.\n\n"
            f'The student asked: "{query}"\n\n'
        )
        body = (
            "Structure your answer:\n"
            "1. What the reference contains — briefly (its columns/rows and what they measure).\n"
            "2. What the image shows — briefly (axes, legend, labeled series/regions).\n"
            "3. The relationship between them — how the reference's data corresponds to or is illustrated "
            "by the image, and vice versa (trends, matches, what one measures about the other).\n"
            "4. A direct answer to the student's specific question, teaching the connection.\n\n"
            "Constraints:\n"
            "- Use ONLY the values present in the reference and what is ACTUALLY visible in the image.\n"
            "- Do NOT invent numbers, data points, axis labels, legends, colors, or curve shapes that are "
            "not present.\n"
            "- Do NOT state a numeric value unless it appears in the reference or is clearly visible in the image.\n"
            "- If the relationship cannot be determined from the supplied reference and image, say so "
            "explicitly rather than guessing.\n"
            "- The reference may be truncated (large tables); reason only over the rows shown."
        )
        note = ""
        if low_confidence:
            note = (
                "\n- The reference or image may not be the one the student intended; note this and "
                "invite them to confirm which they meant."
            )
        return header + body + note

    # -----------------------------------------------------------------------
    # Multi-image reasoning (>= 2 referenced figures co-presented in ONE call)
    # -----------------------------------------------------------------------

    def _escalate_multi_image(
        self,
        results: list[RankedResult],
        query: str,
        query_intent: Any,
        scope_filter: dict | None,
    ) -> EscalationResult | None:
        """Resolve every referenced figure and analyze them in ONE vision call.

        Returns an EscalationResult carrying a single MULTI VisionAnalysis, or None
        when nothing resolved / the vision call failed (caller then falls back to the
        SINGLE-image strategies). When only one of several references resolves we
        still return a MULTI product (describe_each) so the grounding layer can note
        the missing figure (R11); the reference_mapping-vs-figure_references gap is
        the partial-resolution signal.
        """
        references = getattr(query_intent, "figure_references", None) or []
        resolved_images: list[RankedResult] = []
        mapping: list[ResolvedReference] = []
        for ref in references[:_MAX_ESCALATION_IMAGES]:
            image, confidence = self._resolve_figure_image(
                ref, results, scope_filter=scope_filter
            )
            if image is not None and image.image_s3_key:
                resolved_images.append(image)
                mapping.append(
                    ResolvedReference(
                        reference=f"{ref.ref_type.title()} {ref.number}",
                        retrieval_id=image.retrieval_id,
                        image_s3_key=image.image_s3_key,
                        confidence=confidence,
                    )
                )

        if not resolved_images:
            return None

        # Compare only when the student asked to AND we actually have >= 2 images;
        # otherwise describe (e.g. only one of two references resolved).
        prompt_intent = (
            "compare"
            if getattr(query_intent, "requires_comparison", False) and len(resolved_images) >= 2
            else "describe_each"
        )
        labels = [rr.reference for rr in mapping]
        low_confidence = any(rr.confidence == ResolutionConfidence.LOW for rr in mapping)

        analysis_text, vision_confidence = self._invoke_vision_llm_multi(
            resolved_images, labels, query, prompt_intent, low_confidence=low_confidence
        )
        if analysis_text is None:
            return None

        return EscalationResult(
            escalation_used=True,
            vision_analysis=VisionAnalysis(
                mode=VisionMode.MULTI,
                analysis=analysis_text,
                confidence=vision_confidence,
                resolved_images=resolved_images,
                reference_mapping=mapping,
                prompt_intent=prompt_intent,
            ),
        )

    def _resolve_figure_image(
        self, ref: Any, results: list[RankedResult], scope_filter: dict | None = None
    ) -> tuple[RankedResult | None, ResolutionConfidence]:
        """Resolve one figure reference to an image plus a resolution confidence.

        Reuses the existing strategies: a sibling-linked image (co-occurs with the
        query's retrieved context) is the strongest signal -> HIGH. Otherwise a
        scoped, deterministic direct DB lookup provides the image, and confidence
        reflects ambiguity: a lone in-scope match -> HIGH; several candidates in one
        module -> MEDIUM; candidates spanning modules -> LOW (possibly wrong figure).
        """
        sibling_images = self._find_sibling_linked_images(results, ref.number)
        if sibling_images:
            return sibling_images[0], ResolutionConfidence.HIGH

        image = self._find_image_by_figure_ref_in_db(
            ref.ref_type, ref.number, scope_filter=scope_filter
        )
        if image is None:
            return None, ResolutionConfidence.LOW

        count, module_count = self._count_image_candidates(
            ref.ref_type, ref.number, scope_filter=scope_filter
        )
        if count >= 2 and module_count >= 2:
            confidence = ResolutionConfidence.LOW
        elif count >= 2:
            confidence = ResolutionConfidence.MEDIUM
        else:
            confidence = ResolutionConfidence.HIGH
        return image, confidence

    def _count_image_candidates(
        self, ref_type: str, number: str, scope_filter: dict | None = None
    ) -> tuple[int, int]:
        """Count in-scope IMAGE units whose text matches the EXACT reference and how
        many distinct modules they span. Used only to assign resolution confidence.

        Returns (candidate_count, distinct_module_count); (0, 0) on no-DB/error.
        """
        if self._db_connection_factory is None:
            return 0, 0
        try:
            conn = self._db_connection_factory()
            if conn is None:
                return 0, 0
            cur = conn.cursor()
            scope_sql, scope_params = self._scope_predicate(scope_filter)
            ref_regex = self._build_reference_regex(ref_type, number)
            cur.execute(f"""
                SELECT metadata->>'module_id'
                FROM retrieval_units
                WHERE element_type = 'image'
                AND embedding_text ~* %s{scope_sql}
                LIMIT 10;
            """, (ref_regex, *scope_params))
            rows = cur.fetchall()
            cur.close()
            modules = {r[0] for r in rows if r and r[0] is not None}
            return len(rows), len(modules)
        except Exception:
            logger.exception("Error counting figure-reference candidates")
            return 0, 0

    def _invoke_vision_llm_multi(
        self,
        images: list[RankedResult],
        labels: list[str],
        query: str,
        prompt_intent: str,
        low_confidence: bool = False,
    ) -> tuple[str | None, float]:
        """Invoke the multi-image vision model (Sonnet 4.5) with ALL images in ONE call.

        Interleaves a text label and an image block per figure, then the mode prompt.
        Returns (analysis_text, confidence); (None, 0.0) if no image could be fetched
        or the call fails (caller degrades gracefully).
        """
        try:
            import json

            content: list[dict] = []
            for idx, (image, label) in enumerate(zip(images, labels), start=1):
                if not image.image_s3_key:
                    continue
                image_bytes = self._fetch_image(image.image_s3_key)
                if image_bytes is None:
                    continue
                content.append({"type": "text", "text": f"Image {idx} — {label}:"})
                content.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": self._get_media_type(image.image_s3_key),
                            "data": base64.b64encode(image_bytes).decode("utf-8"),
                        },
                    }
                )

            if not any(block["type"] == "image" for block in content):
                logger.warning("Multi-image vision call aborted: no images could be fetched")
                return None, 0.0

            content.append(
                {"type": "text", "text": self._multi_image_prompt(query, prompt_intent, low_confidence)}
            )

            response = self.bedrock_client.invoke_model(
                modelId=COMPARISON_VISION_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=json.dumps(
                    {
                        "anthropic_version": "bedrock-2023-05-31",
                        "max_tokens": 1500,
                        "messages": [{"role": "user", "content": content}],
                    }
                ),
            )
            response_body = json.loads(response["body"].read())
            analysis_text = response_body["content"][0]["text"]
            stop_reason = response_body.get("stop_reason", "end_turn")
            confidence = 0.9 if stop_reason == "end_turn" else 0.7
            logger.info(
                "Multi-image vision analysis complete",
                extra={
                    "model_id": COMPARISON_VISION_MODEL_ID,
                    "prompt_intent": prompt_intent,
                    "image_count": sum(1 for b in content if b["type"] == "image"),
                    "analysis_length": len(analysis_text),
                },
            )
            return analysis_text, confidence
        except Exception:
            logger.exception("Failed to invoke multi-image vision LLM")
            return None, 0.0

    @staticmethod
    def _multi_image_prompt(query: str, prompt_intent: str, low_confidence: bool = False) -> str:
        """Build the trailing instruction block for a multi-image vision call.

        COMPARE is scope-limited to visual-communication quality (NOT algorithm
        correctness), so a "which demonstrates the algorithm better?" question does
        not turn into an unsupported correctness judgment from appearance alone.
        """
        header = (
            "You are analyzing figures from course materials to answer a student's question.\n"
            "You are shown the images above, each labeled with its figure number.\n\n"
            f'The student asked: "{query}"\n\n'
        )
        if prompt_intent == "compare":
            body = (
                "Compare the figures on how well they VISUALLY COMMUNICATE the subject. "
                "Structure your analysis:\n"
                "1. Per figure: briefly, what it depicts (labels, axes, steps shown).\n"
                "2. Similarities in how they present the subject.\n"
                "3. Differences (level of detail, clarity, completeness, what each omits).\n"
                "4. Strengths and weaknesses of EACH for the student's stated purpose.\n"
                "5. A direct, justified answer to the student's question, based only on what is visible.\n\n"
                "Constraints:\n"
                "- Judge ONLY visual-communication quality (clarity, labeling, layout, completeness "
                "of what is shown), NOT the correctness of the underlying algorithm or concept.\n"
                "- Do NOT assume information from the surrounding course that is not visible in the images.\n"
                "- Do NOT infer an algorithm's correctness from how a figure looks.\n"
                "- If the images do not contain enough information to judge, say so rather than guessing."
            )
        else:
            body = (
                "Describe each figure in turn: what it depicts, its key labels/axes/steps, and how it "
                "relates to the question. Do NOT rank or judge the figures against each other unless the "
                "student asked. Ground every claim in what is actually visible."
            )
        note = ""
        if low_confidence:
            note = (
                "\n\nNote: one or more referenced figures could not be identified with certainty "
                "(multiple figures in scope share that number). If a figure shown does not match what "
                "the student meant, say so and invite them to confirm which figure they intended."
            )
        return header + body + note
