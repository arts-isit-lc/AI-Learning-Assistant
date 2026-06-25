"""ImageEscalation fetches images from S3 and invokes vision LLM for analysis.

Classification is handled by QueryAnalyzer (requires_escalation field).
This module only handles execution: S3 fetch + vision LLM call.
"""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass, field
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import ImageAnalysis, RankedResult

logger = Logger(service="multimodal-rag-reasoning")

# Claude 3 Haiku model ID for vision analysis
VISION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"


@dataclass
class EscalationResult:
    """Result of image escalation processing."""

    escalation_used: bool
    image_analyses: list[ImageAnalysis] = field(default_factory=list)


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
        self, results: list[RankedResult], query: str, query_intent=None
    ) -> EscalationResult:
        """Perform image escalation on ranked results.

        When a figure_reference is present in query_intent, prefers images that
        are siblings of text results containing matching figure captions.
        Falls back to top-scoring images when no sibling link exists.

        Args:
            results: Ranked results from the retrieval layer.
            query: The user's original query for vision analysis context.
            query_intent: Optional QueryIntent with figure_reference for targeted lookup.

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
                    analyses: list[ImageAnalysis] = []
                    for img_result in sibling_images[:2]:  # max 2
                        analysis = self._analyze_image(img_result, query)
                        if analysis is not None:
                            analyses.append(analysis)
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

            # Select top 2 by score (descending)
            sorted_results = sorted(
                image_results, key=lambda r: r.score, reverse=True
            )
            top_results = sorted_results[:2]

            logger.info(
                "Using score-based image selection",
                extra={
                    "top_image_scores": [round(r.score, 4) for r in top_results],
                    "top_image_keys": [r.image_s3_key for r in top_results],
                },
            )

            analyses = []

            for result in top_results:
                analysis = self._analyze_image(result, query)
                if analysis is not None:
                    analyses.append(analysis)

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

    def _find_image_by_figure_ref_in_db(
        self, ref_type: str, number: str
    ) -> RankedResult | None:
        """Query the database directly for an image linked to a figure reference.

        This bypasses the ranked results and finds the image by:
        1. Looking for a text retrieval unit with matching figure_ref metadata
        2. Getting its sibling image via sibling_ids
        3. Constructing a RankedResult for the image

        Args:
            ref_type: Type of reference ("figure", "table", "algorithm").
            number: The number (e.g., "1.1").

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

            # Strategy A: Find image directly by matching embedding_text
            figure_pattern = f"%{ref_type} {number}%"
            cur.execute("""
                SELECT retrieval_id, embedding_text, metadata
                FROM retrieval_units
                WHERE element_type = 'image'
                AND LOWER(embedding_text) LIKE LOWER(%s)
                LIMIT 1;
            """, (figure_pattern,))

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
            cur.execute("""
                SELECT sibling_ids
                FROM retrieval_units
                WHERE metadata->>'figure_ref' ILIKE %s
                LIMIT 1;
            """, (figure_ref_value,))

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
                cur.execute("""
                    SELECT metadata->>'provenance_page_num' as page_num
                    FROM retrieval_units
                    WHERE element_type = 'table'
                    AND LOWER(embedding_text) LIKE LOWER(%s)
                    LIMIT 1;
                """, (f"%{ref_type} {number}%",))

                row = cur.fetchone()
                if row and row[0]:
                    page_num = row[0]
                    # Look for a page-render image on the same page
                    cur.execute("""
                        SELECT retrieval_id, embedding_text, metadata
                        FROM retrieval_units
                        WHERE element_type = 'image'
                        AND metadata->>'provenance_page_num' = %s
                        AND metadata->>'image_s3_key' IS NOT NULL
                        ORDER BY
                            CASE WHEN metadata->>'render_reason' = 'vector_graphics_detected' THEN 0 ELSE 1 END
                        LIMIT 1;
                    """, (page_num,))

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
