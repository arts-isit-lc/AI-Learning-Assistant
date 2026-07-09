"""Enrichment Lambda handler.

Triggered by SQS message after IR persistence. Loads DocumentIR from S3,
enriches elements via ElementRouter, generates DocumentSummary, builds
RetrievalUnits, generates embeddings, and stores in pgvector.

Environment variables:
- IR_BUCKET_NAME: S3 bucket for IR storage
- EMBEDDING_CACHE_TABLE: DynamoDB table for embedding cache
- ENRICHMENT_CACHE_TABLE: DynamoDB table for enrichment cache
- DB_SECRET_ARN: Secrets Manager ARN for database credentials
- DB_PROXY_ENDPOINT: RDS Proxy endpoint for pgvector

Requirements: 3.1, 4.1, 5.1, 6.1
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import replace
from typing import Any

try:
    from aws_xray_sdk.core import patch_all, xray_recorder
    xray_recorder.configure(context_missing='LOG_ERROR')
    patch_all()
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")

import boto3
from aws_lambda_powertools import Logger

from ..cache.embedding_cache import EmbeddingCache
from ..cache.enrichment_cache import EnrichmentCache, compute_context_hash
from ..models.data_models import (
    EMBEDDING_VERSION,
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    RetrievalUnit,
)
from ..persistence.ir_persistence import IRPersistence
from .document_summary import DocumentSummaryGenerator
from .element_router import ElementRouter
from .embedding_generator import EmbeddingGenerator
from .formula_service import FormulaService
from .retrieval_unit_builder import RetrievalUnitBuilder
from .table_service import TableService
from .text_chunker import TextChunker
from .vision_service import VisionService

logger = Logger(service="multimodal-rag-enrichment", log_uncaught_exceptions=True)

# ---------------------------------------------------------------------------
# Service wiring (module-level singletons, initialized once per container)
# ---------------------------------------------------------------------------

bedrock_client = boto3.client("bedrock-runtime")

ir_persistence = IRPersistence()

vision_service = VisionService(bedrock_client=bedrock_client)

element_router = ElementRouter(
    text_chunker=TextChunker(),
    vision_service=vision_service,
    formula_service=FormulaService(vision_service=vision_service),
    table_service=TableService(),
)

retrieval_unit_builder = RetrievalUnitBuilder()

embedding_cache = EmbeddingCache()
enrichment_cache = EnrichmentCache()

embedding_generator = EmbeddingGenerator(
    bedrock_client=bedrock_client,
    embedding_cache=embedding_cache,
)

document_summary_gen = DocumentSummaryGenerator(bedrock_client=bedrock_client)


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------


@logger.inject_lambda_context(clear_state=True)
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Enrichment Lambda handler — processes SQS messages from ingestion.

    Each SQS record contains a message body with:
    - course_id: course identifier
    - module_id: module identifier
    - file_id: file identifier
    - ir_version: version of the persisted IR

    Flow:
    1. Parse SQS messages
    2. Load DocumentIR from S3 via IRPersistence
    3. Enrich elements via ElementRouter
    4. Check/store enrichment cache
    5. Generate DocumentSummary
    6. Build RetrievalUnits via RetrievalUnitBuilder
    7. Generate embeddings via EmbeddingGenerator
    8. Store in pgvector

    Args:
        event: SQS event with Records array.
        context: Lambda context.

    Returns:
        Response dict with processing results.
    """
    records = event.get("Records", [])
    if not records:
        logger.warning("No records in SQS event")
        return {"batchItemFailures": []}

    results: list[dict[str, Any]] = []
    batch_item_failures: list[dict[str, str]] = []

    for record in records:
        try:
            result = _process_record(record)
            results.append(result)
        except Exception:
            message_id = record.get("messageId", "unknown")
            logger.exception(
                "Failed to process SQS record — will be retried via SQS",
                extra={"message_id": message_id},
            )
            batch_item_failures.append({"itemIdentifier": message_id})

    logger.info(
        "Enrichment batch complete",
        extra={
            "total_records": len(records),
            "processed": len(results),
            "failed": len(batch_item_failures),
        },
    )

    # SQS partial batch response: only the listed message IDs are retried.
    # Requires reportBatchItemFailures=true on the event source mapping.
    return {"batchItemFailures": batch_item_failures}


def _process_record(record: dict[str, Any]) -> dict[str, Any]:
    """Process a single SQS record through the enrichment pipeline.

    Args:
        record: SQS record with message body containing document identifiers.

    Returns:
        Dict with processing result (file_id, retrieval_unit_count, status).

    Raises:
        Exception: On unrecoverable errors (propagated to caller for retry).
    """
    body = json.loads(record.get("body", "{}"))

    course_id = body["course_id"]
    module_id = body["module_id"]
    file_id = body["file_id"]
    ir_version = body.get("ir_version")

    logger.append_keys(
        course_id=course_id,
        module_id=module_id,
        file_id=file_id,
    )

    logger.info(
        "Processing enrichment request",
        extra={"ir_version": ir_version},
    )

    # eager-module-creation Req 5.9/5.10: do not process work for a module that is
    # being deleted (or no longer exists). Skip and return a normal (non-failure)
    # result so the SQS message is acked rather than retried, and no orphan
    # embeddings are written to pgvector.
    if _module_is_deleting_or_missing(module_id):
        logger.warning(
            "Module is deleting or missing — skipping enrichment and discarding event",
            extra={"module_id": module_id, "file_id": file_id},
        )
        return {
            "file_id": file_id,
            "retrieval_unit_count": 0,
            "status": "skipped_module_deleting",
        }

    record_start = time.time()

    # Step 1: Load DocumentIR from S3
    ir_load_start = time.time()
    document_ir = ir_persistence.load(
        course_id=course_id,
        module_id=module_id,
        file_id=file_id,
        ir_version=ir_version,
    )
    ir_load_latency = time.time() - ir_load_start

    logger.info(
        "DocumentIR loaded",
        extra={
            "element_count": len(document_ir.elements),
            "ir_load_latency_ms": round(ir_load_latency * 1000, 2),
        },
    )

    # Step 2: Enrich elements via ElementRouter (handles fallback, retries, visual cap)
    enrich_start = time.time()
    enriched_elements = _enrich_with_cache(document_ir, course_id, module_id)
    enrich_latency = time.time() - enrich_start

    logger.info(
        "Elements enriched",
        extra={
            "enriched_count": len(enriched_elements),
            "enrich_latency_ms": round(enrich_latency * 1000, 2),
        },
    )

    # Step 3: Generate DocumentSummary
    summary_start = time.time()
    doc_summary, summary_unit = document_summary_gen.generate(document_ir)
    summary_latency = time.time() - summary_start

    logger.info(
        "Document summary generated",
        extra={
            "summary_topics": len(doc_summary.topics),
            "summary_latency_ms": round(summary_latency * 1000, 2),
        },
    )

    # Step 4: Build RetrievalUnits from enriched elements
    ru_build_start = time.time()
    retrieval_units = retrieval_unit_builder.build(enriched_elements)
    ru_build_latency = time.time() - ru_build_start

    # Add the document summary RetrievalUnit
    retrieval_units.append(summary_unit)

    # DEBUG: Check if caption injection and sibling linking are working
    units_with_figure_ref = [u for u in retrieval_units if u.metadata.get("figure_ref")]
    units_with_siblings = [u for u in retrieval_units if u.sibling_ids]
    table_units = [u for u in retrieval_units if u.element_type.value == "table"]
    image_units = [u for u in retrieval_units if u.element_type.value == "image"]
    logger.info(
        "RetrievalUnits built",
        extra={
            "retrieval_unit_count": len(retrieval_units),
            "summary_topics": len(doc_summary.topics),
            "units_with_figure_ref": len(units_with_figure_ref),
            "units_with_siblings": len(units_with_siblings),
            "table_units": len(table_units),
            "image_units": len(image_units),
            "sample_table_text": table_units[0].embedding_text[:100] if table_units else "NO_TABLES",
            "ru_build_latency_ms": round(ru_build_latency * 1000, 2),
        },
    )

    # Step 5: Generate embeddings for each RetrievalUnit
    embed_start = time.time()
    _generate_embeddings(retrieval_units)
    embed_latency = time.time() - embed_start

    # Step 6: Store in pgvector
    store_start = time.time()
    _store_in_pgvector(retrieval_units, course_id, module_id, file_id)
    store_latency = time.time() - store_start

    # Step 7: Extract topics and store in Module_Files.metadata for the topic aggregation pipeline
    _extract_and_store_topics(enriched_elements, file_id, module_id)

    # Step 8: Update Module_Files.processing_status so the UI stops showing the spinner
    _update_processing_status(file_id, module_id, len(retrieval_units))

    total_latency = time.time() - record_start

    logger.info(
        "Enrichment pipeline complete",
        extra={
            "file_id": file_id,
            "retrieval_unit_count": len(retrieval_units),
            "total_latency_ms": round(total_latency * 1000, 2),
            "ir_load_latency_ms": round(ir_load_latency * 1000, 2),
            "enrich_latency_ms": round(enrich_latency * 1000, 2),
            "summary_latency_ms": round(summary_latency * 1000, 2),
            "ru_build_latency_ms": round(ru_build_latency * 1000, 2),
            "embed_latency_ms": round(embed_latency * 1000, 2),
            "store_latency_ms": round(store_latency * 1000, 2),
        },
    )

    return {
        "file_id": file_id,
        "retrieval_unit_count": len(retrieval_units),
        "status": "success",
    }


def _enrich_with_cache(
    document_ir: Any,
    course_id: str,
    module_id: str,
) -> list[EnrichedElement]:
    """Enrich document elements with enrichment cache integration.

    Checks EnrichmentCache before invoking enrichment services.
    Stores results in cache after enrichment.

    Args:
        document_ir: The DocumentIR to enrich.
        course_id: Course identifier for context-dependent caching.
        module_id: Module identifier for context-dependent caching.

    Returns:
        List of all EnrichedElements produced.
    """
    all_enriched: list[EnrichedElement] = []
    elements_to_enrich = []

    # Check enrichment cache for each element
    for element in document_ir.elements:
        # H4: never cache TEXT. TextChunker makes NO LLM calls (zero cost
        # benefit to caching), and a multi-chunk TEXT element yields N
        # EnrichedElements that all share ONE content_hash and a version-only
        # sort key — so N cache puts overwrite each other and a later hit
        # returns a single chunk, silently dropping the rest (recall loss).
        # Always re-chunk TEXT instead.
        if element.element_type == ElementType.TEXT:
            elements_to_enrich.append((element, ""))
            continue

        context_hash = ""
        if element.element_type in (ElementType.IMAGE, ElementType.TABLE):
            context_hash = compute_context_hash(course_id, module_id)

        cached = enrichment_cache.get(
            content_hash=element.content_hash,
            element_type=element.element_type,
            enrichment_version=ENRICHMENT_VERSION,
            context_hash=context_hash,
        )

        if cached is not None:
            logger.info(
                "Enrichment cache hit",
                extra={
                    "element_id": element.element_id,
                    "element_type": element.element_type.value,
                },
            )
            all_enriched.append(cached)
        else:
            elements_to_enrich.append((element, context_hash))

    # Enrich uncached elements via ElementRouter
    if elements_to_enrich:
        # L2: enrich ONLY the uncached subset. Previously the whole DocumentIR
        # was passed to the router, so every cache miss re-ran vision on
        # already-cached images/tables (expensive + non-deterministic). A
        # filtered DocumentIR (same file_metadata, subset of elements) enriches
        # just what's missing; enrich_document treats each element independently.
        subset_ir = replace(
            document_ir,
            elements=[el for el, _ in elements_to_enrich],
        )
        enriched_from_router = element_router.enrich_document(subset_ir)

        # Map enriched results back and store in cache
        enriched_by_id: dict[str, list[EnrichedElement]] = {}
        for enriched in enriched_from_router:
            enriched_by_id.setdefault(enriched.element_id, []).append(enriched)

        for element, context_hash in elements_to_enrich:
            element_enriched = enriched_by_id.get(element.element_id, [])
            for enriched in element_enriched:
                all_enriched.append(enriched)
                # H4: never write TEXT to the cache (see above).
                if element.element_type == ElementType.TEXT:
                    continue
                # L6: never cache a degraded/fallback result — otherwise a
                # transient vision/throttle failure (or a visual-cap skip) gets
                # cached and stays degraded on every future re-ingestion.
                if getattr(enriched, "is_fallback", False):
                    logger.info(
                        "Skipping cache store for fallback enrichment",
                        extra={"element_id": element.element_id,
                               "element_type": element.element_type.value},
                    )
                    continue
                # Store in enrichment cache
                enrichment_cache.put(
                    content_hash=element.content_hash,
                    enriched_element=enriched,
                    element_type=element.element_type,
                    enrichment_version=ENRICHMENT_VERSION,
                    context_hash=context_hash,
                )

    return all_enriched


_EMBED_MAX_RETRIES = int(os.environ.get("EMBED_MAX_RETRIES", "3"))
_EMBED_BACKOFF_INITIAL = float(os.environ.get("EMBED_BACKOFF_INITIAL_SECONDS", "0.5"))
# Fail the whole record (SQS retry) when fewer than this fraction of embeddings
# succeed. Protects an existing index from being DELETE+committed away under a
# throttling burst. Set to 0 to disable (not recommended).
_MIN_EMBED_SUCCESS_RATE = float(os.environ.get("MIN_EMBED_SUCCESS_RATE", "0.5"))


def _embed_with_backoff(text: str, content_hash: str) -> list[float] | None:
    """Generate one embedding with exponential backoff on transient errors.

    EmbeddingGenerator does not retry, so under Titan throttling during bulk
    ingestion embeddings used to fail-and-skip on the first error (H5). Returns
    None only after exhausting retries.
    """
    delay = _EMBED_BACKOFF_INITIAL
    for attempt in range(_EMBED_MAX_RETRIES + 1):
        try:
            return embedding_generator.generate(text=text, content_hash=content_hash)
        except Exception:
            if attempt >= _EMBED_MAX_RETRIES:
                logger.exception(
                    "Embedding failed after retries",
                    extra={"content_hash": content_hash[:16], "attempts": attempt + 1},
                )
                return None
            time.sleep(delay)
            delay *= 2
    return None  # pragma: no cover


def _generate_embeddings(retrieval_units: list[RetrievalUnit]) -> None:
    """Generate embeddings for all RetrievalUnits (backoff + success gate).

    H5: embedding failures used to be swallowed per-unit with no backoff, so a
    burst of Titan throttling silently dropped most/all embeddings; the store
    step then DELETEd the file's existing vectors and inserted only what
    embedded, marking the file "complete" but unsearchable. We now retry with
    backoff and RAISE if too few embeddings succeed, so the SQS message is
    retried and the existing index is left intact (the DELETE never runs).

    Args:
        retrieval_units: List of RetrievalUnits to embed.
    """
    embeddable = [
        u for u in retrieval_units if u.embedding_text and u.embedding_text.strip()
    ]
    if not embeddable:
        logger.info("No embeddable retrieval units (all empty embedding_text)")
        return

    succeeded = 0
    for unit in embeddable:
        content_hash = hashlib.sha256(unit.embedding_text.encode("utf-8")).hexdigest()
        embedding = _embed_with_backoff(unit.embedding_text, content_hash)
        if embedding is None:
            continue
        # Attach embedding to unit metadata for downstream storage
        unit.metadata["embedding"] = embedding
        unit.metadata["embedding_version"] = EMBEDDING_VERSION
        succeeded += 1

    success_rate = succeeded / len(embeddable)
    logger.info(
        "Embedding generation complete",
        extra={
            "embeddable_units": len(embeddable),
            "succeeded": succeeded,
            "success_rate": round(success_rate, 3),
        },
    )

    # H5: refuse to proceed to the destructive store step when embeddings mostly
    # failed. Raising fails the SQS record (retried, then DLQ'd), so the file is
    # NOT marked complete and its existing vectors are preserved.
    if success_rate < _MIN_EMBED_SUCCESS_RATE:
        raise RuntimeError(
            f"Only {succeeded}/{len(embeddable)} embeddings succeeded "
            f"(< {_MIN_EMBED_SUCCESS_RATE:.0%} threshold); failing record so SQS "
            f"retries and the existing index is preserved"
        )


def _module_is_deleting_or_missing(module_id: str) -> bool:
    """Return True if the module is in 'deleting' status or no longer exists.

    Implements eager-module-creation Req 5.9/5.10: the enrichment pipeline must
    not write embeddings for a module that is being cleaned up (or was deleted
    mid-flight). Queries Course_Modules.status via the RDS proxy.

    Fails open (returns False) when the DB is not configured or the status check
    errors transiently, so legitimate work is never silently dropped — a genuine
    DB outage surfaces later in _store_in_pgvector, which raises and triggers an
    SQS retry rather than losing the write.

    Args:
        module_id: The module identifier parsed from the ingestion event.

    Returns:
        True  -> skip processing (status == 'deleting' or module row not found).
        False -> proceed (active/draft module, or status could not be determined).
    """
    db_proxy_endpoint = os.environ.get("DB_PROXY_ENDPOINT", "")
    db_secret_arn = os.environ.get("DB_SECRET_ARN", "")

    if not db_proxy_endpoint or not db_secret_arn:
        # DB not configured (e.g. local/dev) — cannot check, so proceed.
        return False

    import json as json_mod
    import psycopg2

    conn = None
    try:
        secrets_client = boto3.client("secretsmanager")
        secret = json_mod.loads(
            secrets_client.get_secret_value(SecretId=db_secret_arn)["SecretString"]
        )
        conn = psycopg2.connect(
            dbname=secret["dbname"],
            user=secret["username"],
            password=secret["password"],
            host=db_proxy_endpoint,
            port=secret["port"],
            sslmode="require",
        )
        cur = conn.cursor()
        cur.execute(
            'SELECT status FROM "Course_Modules" WHERE module_id = %s',
            (module_id,),
        )
        row = cur.fetchone()
        cur.close()

        if row is None:
            # Req 5.9: module record not found — discard without error.
            return True
        return row[0] == "deleting"
    except Exception:
        logger.warning(
            "Could not verify module status; proceeding with enrichment",
            extra={"module_id": module_id},
        )
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _store_in_pgvector(
    retrieval_units: list[RetrievalUnit],
    course_id: str,
    module_id: str,
    file_id: str,
) -> None:
    """Store RetrievalUnits in pgvector with all metadata.

    Connects to RDS via Proxy (DB_SECRET_ARN + DB_PROXY_ENDPOINT), deletes any
    existing units for this file (incremental re-ingestion), then inserts each
    unit with its embedding and ts_vector. Raises on failure so the SQS message
    is retried (and eventually dead-lettered) rather than the write being lost.

    Args:
        retrieval_units: List of RetrievalUnits with embeddings attached.
        course_id: Course identifier for metadata.
        module_id: Module identifier for metadata.
        file_id: File identifier for metadata.
    """
    db_proxy_endpoint = os.environ.get("DB_PROXY_ENDPOINT", "")
    db_secret_arn = os.environ.get("DB_SECRET_ARN", "")

    if not db_proxy_endpoint or not db_secret_arn:
        logger.warning(
            "pgvector storage not configured (DB_PROXY_ENDPOINT or DB_SECRET_ARN missing), "
            "skipping storage",
            extra={
                "file_id": file_id,
                "retrieval_unit_count": len(retrieval_units),
            },
        )
        return

    # Count units with embeddings
    units_with_embeddings = [
        u for u in retrieval_units if "embedding" in u.metadata
    ]

    # H5: never DELETE the file's existing vectors when there is nothing to
    # insert — that leaves the file unsearchable but marked "complete". Raise so
    # the SQS record is retried and the current index is preserved. (Defense in
    # depth: _generate_embeddings already raises on a low success rate.)
    if not units_with_embeddings:
        raise RuntimeError(
            f"No embeddable units to store for file {file_id}; refusing to "
            f"DELETE+commit an empty index (would wipe existing vectors)"
        )

    logger.info(
        "Storing RetrievalUnits in pgvector",
        extra={
            "file_id": file_id,
            "total_units": len(retrieval_units),
            "units_with_embeddings": len(units_with_embeddings),
            "course_id": course_id,
            "module_id": module_id,
            "db_proxy_endpoint": db_proxy_endpoint,
        },
    )

    import json as json_mod
    import psycopg2

    try:
        secrets_client = boto3.client("secretsmanager")
        secret = json_mod.loads(
            secrets_client.get_secret_value(SecretId=db_secret_arn)["SecretString"]
        )
        conn = psycopg2.connect(
            dbname=secret["dbname"],
            user=secret["username"],
            password=secret["password"],
            host=db_proxy_endpoint,
            port=secret["port"],
            sslmode="require",
        )
        cur = conn.cursor()

        # Delete existing units for this file (incremental re-ingestion).
        # Use the first-class indexed file_id column (M9) so this matches
        # deleteFile, retrieval scoping, and idx_retrieval_units_file_id — the
        # metadata->>'file_id' JSON path was unindexed and diverged from the
        # rest of the system.
        cur.execute(
            "DELETE FROM retrieval_units WHERE file_id = %s",
            (file_id,),
        )

        # Insert each unit with embedding
        inserted = 0
        for unit in units_with_embeddings:
            embedding = unit.metadata.get("embedding", [])
            if not embedding:
                continue

            # Build metadata (exclude the embedding from stored metadata)
            stored_metadata = {k: v for k, v in unit.metadata.items() if k != "embedding"}
            stored_metadata["file_id"] = file_id
            stored_metadata["course_id"] = course_id
            stored_metadata["module_id"] = module_id

            embedding_str = f"[{','.join(str(v) for v in embedding)}]"

            cur.execute(
                """INSERT INTO retrieval_units
                   (retrieval_id, parent_element_id, embedding_text, element_type,
                    embedding, embedding_version, metadata, sibling_ids, ts_vector,
                    file_id, module_id)
                   VALUES (%s, %s, %s, %s, %s::vector, %s, %s::jsonb, %s::jsonb,
                           to_tsvector('english', %s), %s, %s)
                   ON CONFLICT (retrieval_id) DO UPDATE SET
                    embedding_text = EXCLUDED.embedding_text,
                    embedding = EXCLUDED.embedding,
                    metadata = EXCLUDED.metadata,
                    sibling_ids = EXCLUDED.sibling_ids,
                    ts_vector = EXCLUDED.ts_vector,
                    file_id = EXCLUDED.file_id,
                    module_id = EXCLUDED.module_id""",
                (
                    unit.retrieval_id,
                    unit.parent_element_id,
                    unit.embedding_text,
                    unit.element_type.value if hasattr(unit.element_type, 'value') else str(unit.element_type),
                    embedding_str,
                    unit.embedding_version,
                    json_mod.dumps(stored_metadata),
                    json_mod.dumps(unit.sibling_ids),
                    unit.embedding_text,
                    file_id,
                    module_id,
                ),
            )
            inserted += 1

        conn.commit()
        cur.close()
        conn.close()

        logger.info(
            "pgvector storage complete",
            extra={
                "file_id": file_id,
                "stored_count": inserted,
            },
        )

    except Exception:
        logger.exception(
            "pgvector storage failed",
            extra={"file_id": file_id, "retrieval_unit_count": len(units_with_embeddings)},
        )
        # Re-raise so the enrichment record fails, the SQS message is retried,
        # and processing_status is NOT marked 'complete' on a failed write.
        raise


def _update_processing_status(file_id: str, module_id: str, chunk_count: int) -> None:
    """Update Module_Files.processing_status to 'complete' in RDS.

    This signals the frontend UI to stop showing the spinner.
    Best-effort: logs errors but never raises.

    Args:
        file_id: The canonical UUID file_id — equal to Module_Files.file_id (the
            primary key). Since the cross-module-file-referencing change this is
            the DB UUID, not the filename stem.
        module_id: The module this file belongs to (used for log correlation).
        chunk_count: Number of retrieval units produced (stored as chunk_count).
    """
    import psycopg2

    db_proxy_endpoint = os.environ.get("DB_PROXY_ENDPOINT", "")
    db_secret_arn = os.environ.get("DB_SECRET_ARN", "")

    if not db_proxy_endpoint or not db_secret_arn:
        logger.warning("Cannot update processing_status: DB not configured")
        return

    try:
        import json
        secrets_client = boto3.client("secretsmanager")
        secret = json.loads(
            secrets_client.get_secret_value(SecretId=db_secret_arn)["SecretString"]
        )
        conn = psycopg2.connect(
            dbname=secret["dbname"],
            user=secret["username"],
            password=secret["password"],
            host=db_proxy_endpoint,
            port=secret["port"],
            sslmode="require",
        )
        cur = conn.cursor()
        # Match on the canonical UUID primary key. Before the cross-module-file-
        # referencing change file_id was the filename stem and this matched on
        # `filename`; file_id is now the Module_Files.file_id UUID.
        cur.execute(
            """UPDATE "Module_Files"
               SET processing_status = 'complete', chunk_count = %s, last_processed_at = NOW()
               WHERE file_id = %s""",
            (chunk_count, file_id),
        )
        conn.commit()
        updated = cur.rowcount
        cur.close()
        conn.close()
        if updated:
            logger.info(
                "Processing status updated to complete",
                extra={"file_id": file_id, "module_id": module_id, "rows_updated": updated},
            )
        else:
            # A zero-row update means file_id matched no Module_Files row. Surfaced
            # as a warning so it is not silently lost — the previous filename-based
            # match failed exactly this way and left the UI spinner stuck.
            logger.warning(
                "Processing status update matched no rows; spinner will not clear",
                extra={"file_id": file_id, "module_id": module_id},
            )
    except Exception:
        logger.exception("Failed to update processing_status (best-effort)", extra={"file_id": file_id})


def _extract_and_store_topics(
    enriched_elements: list,
    file_id: str,
    module_id: str,
) -> None:
    """Extract topics from document text via Claude Haiku and store in Module_Files.metadata.

    This enables the topic aggregation pipeline (generate_topics endpoint) to
    consolidate per-file topics into module-level generated_topics.

    Best-effort: logs errors but never raises.

    Args:
        enriched_elements: List of EnrichedElements from enrichment.
        file_id: The canonical UUID file_id — equal to Module_Files.file_id (PK).
        module_id: Module identifier (used for log correlation).
    """
    import psycopg2
    from datetime import datetime, timezone

    db_proxy_endpoint = os.environ.get("DB_PROXY_ENDPOINT", "")
    db_secret_arn = os.environ.get("DB_SECRET_ARN", "")

    if not db_proxy_endpoint or not db_secret_arn:
        logger.warning("Cannot extract topics: DB not configured")
        return

    # Collect text content from enriched elements (cap at 15000 chars for Haiku)
    text_parts = []
    total_chars = 0
    max_chars = 15000

    for elem in enriched_elements:
        if elem.embedding_text and total_chars < max_chars:
            text_parts.append(elem.embedding_text)
            total_chars += len(elem.embedding_text)

    if not text_parts:
        logger.warning("No text content for topic extraction", extra={"file_id": file_id})
        return

    full_text = "\n\n".join(text_parts)[:max_chars]

    # Call Haiku for topic extraction
    extraction_prompt = """Analyze this educational document and extract the core subject matter.

Identify the specific concepts that would appear as:
- Lecture topics or section headings
- Exam questions or assessment items
- Learning outcomes in a course syllabus

Extract the concepts that are distinct and assessable. Do NOT collapse multiple distinct concepts into one broader category.

Exclude:
- Examples and case studies (unless they ARE the topic)
- Citations, references, and bibliographic entries
- Administrative content (syllabus logistics, grading policies)

Return ONLY a valid JSON object (no markdown, no explanation):
{
    "topics": ["topic1", "topic2", ...],
    "learning_objectives": ["objective1", "objective2", ...],
    "confidence": 0.0
}

Limit: maximum 5 topics and 5 learning objectives.

Document text:
"""

    try:
        import json as json_mod
        bedrock_client = boto3.client("bedrock-runtime", region_name=os.environ.get("REGION", "ca-central-1"))

        request_body = json_mod.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "messages": [
                {"role": "user", "content": extraction_prompt + full_text}
            ]
        })

        response = bedrock_client.invoke_model(
            # Claude Haiku 4.5 via Geo-US cross-Region inference profile.
            modelId="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            body=request_body,
        )
        result = json_mod.loads(response["body"].read())

        if not result.get("content") or not result["content"][0].get("text"):
            logger.warning("Empty Haiku response for topic extraction", extra={"file_id": file_id})
            return

        content = result["content"][0]["text"].strip()

        # Strip markdown fences if present
        if content.startswith("```"):
            content = content.split("\n", 1)[1] if "\n" in content else content[3:]
            if content.endswith("```"):
                content = content[:-3]
            content = content.strip()

        parsed = json_mod.loads(content)

        # Validate and sanitize
        if "topics" not in parsed or not isinstance(parsed["topics"], list):
            logger.warning("Invalid topic extraction response", extra={"file_id": file_id})
            return

        parsed["topics"] = [t.strip() for t in parsed["topics"] if isinstance(t, str) and t.strip()][:5]
        parsed["learning_objectives"] = [
            o.strip() for o in parsed.get("learning_objectives", [])
            if isinstance(o, str) and o.strip()
        ][:5]

        if "confidence" not in parsed or not isinstance(parsed.get("confidence"), (int, float)):
            parsed["confidence"] = 0.85
        parsed["coverage"] = 1.0 if total_chars <= max_chars else round(max_chars / total_chars, 2)
        parsed["extracted_at"] = datetime.now(timezone.utc).isoformat()
        parsed["model"] = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        parsed["version"] = 2
        parsed["extraction_method"] = "full_document" if total_chars <= max_chars else "sampled_document"

        # Write to Module_Files.metadata
        secrets_client = boto3.client("secretsmanager")
        secret = json_mod.loads(
            secrets_client.get_secret_value(SecretId=db_secret_arn)["SecretString"]
        )
        conn = psycopg2.connect(
            dbname=secret["dbname"],
            user=secret["username"],
            password=secret["password"],
            host=db_proxy_endpoint,
            port=secret["port"],
            sslmode="require",
        )
        cur = conn.cursor()

        # Read existing metadata to merge. Match on the canonical UUID primary key
        # (file_id is the Module_Files.file_id UUID since the cross-module change).
        cur.execute('SELECT metadata FROM "Module_Files" WHERE file_id = %s', (file_id,))
        row = cur.fetchone()
        existing = {}
        if row and row[0]:
            existing = row[0] if isinstance(row[0], dict) else json_mod.loads(row[0])

        existing["topic_extraction"] = parsed

        cur.execute(
            """UPDATE "Module_Files" SET metadata = %s::jsonb WHERE file_id = %s""",
            (json_mod.dumps(existing), file_id),
        )
        conn.commit()
        cur.close()
        conn.close()

        logger.info(
            "Topic extraction complete",
            extra={
                "file_id": file_id,
                "module_id": module_id,
                "topic_count": len(parsed["topics"]),
                "topics": parsed["topics"],
            },
        )

    except Exception:
        logger.exception("Topic extraction failed (best-effort)", extra={"file_id": file_id})
