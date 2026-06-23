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
    8. Store in pgvector (placeholder)

    Args:
        event: SQS event with Records array.
        context: Lambda context.

    Returns:
        Response dict with processing results.
    """
    records = event.get("Records", [])
    if not records:
        logger.warning("No records in SQS event")
        return {"statusCode": 200, "body": json.dumps({"processed": 0})}

    results: list[dict[str, Any]] = []
    failed_count = 0

    for record in records:
        try:
            result = _process_record(record)
            results.append(result)
        except Exception:
            failed_count += 1
            message_id = record.get("messageId", "unknown")
            logger.exception(
                "Failed to process SQS record",
                extra={"message_id": message_id},
            )

    response = {
        "statusCode": 200,
        "body": json.dumps({
            "processed": len(results),
            "failed": failed_count,
            "results": results,
        }),
    }

    logger.info(
        "Enrichment batch complete",
        extra={
            "total_records": len(records),
            "processed": len(results),
            "failed": failed_count,
        },
    )

    return response


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

    # Step 1: Load DocumentIR from S3
    document_ir = ir_persistence.load(
        course_id=course_id,
        module_id=module_id,
        file_id=file_id,
        ir_version=ir_version,
    )

    logger.info(
        "DocumentIR loaded",
        extra={"element_count": len(document_ir.elements)},
    )

    # Step 2: Enrich elements via ElementRouter (handles fallback, retries, visual cap)
    enriched_elements = _enrich_with_cache(document_ir, course_id, module_id)

    logger.info(
        "Elements enriched",
        extra={"enriched_count": len(enriched_elements)},
    )

    # Step 3: Generate DocumentSummary
    doc_summary, summary_unit = document_summary_gen.generate(document_ir)

    # Step 4: Build RetrievalUnits from enriched elements
    retrieval_units = retrieval_unit_builder.build(enriched_elements)

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
        },
    )

    # Step 5: Generate embeddings for each RetrievalUnit
    _generate_embeddings(retrieval_units)

    # Step 6: Store in pgvector (placeholder — actual storage wired in CDK)
    _store_in_pgvector(retrieval_units, course_id, module_id, file_id)

    # Step 7: Extract topics and store in Module_Files.metadata for the topic aggregation pipeline
    _extract_and_store_topics(enriched_elements, file_id, module_id)

    # Step 8: Update Module_Files.processing_status so the UI stops showing the spinner
    _update_processing_status(file_id, module_id, len(retrieval_units))

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
        # Build a minimal DocumentIR-like structure for the router
        # The router expects a full DocumentIR, so we use the original
        enriched_from_router = element_router.enrich_document(document_ir)

        # Map enriched results back and store in cache
        enriched_by_id: dict[str, list[EnrichedElement]] = {}
        for enriched in enriched_from_router:
            enriched_by_id.setdefault(enriched.element_id, []).append(enriched)

        for element, context_hash in elements_to_enrich:
            element_enriched = enriched_by_id.get(element.element_id, [])
            for enriched in element_enriched:
                all_enriched.append(enriched)
                # Store in enrichment cache
                enrichment_cache.put(
                    content_hash=element.content_hash,
                    enriched_element=enriched,
                    element_type=element.element_type,
                    enrichment_version=ENRICHMENT_VERSION,
                    context_hash=context_hash,
                )

    return all_enriched


def _generate_embeddings(retrieval_units: list[RetrievalUnit]) -> None:
    """Generate embeddings for all RetrievalUnits.

    Uses EmbeddingGenerator which internally handles caching.
    Skips units with empty embedding_text.

    Args:
        retrieval_units: List of RetrievalUnits to embed.
    """
    for unit in retrieval_units:
        if not unit.embedding_text or not unit.embedding_text.strip():
            continue

        try:
            content_hash = hashlib.sha256(
                unit.embedding_text.encode("utf-8")
            ).hexdigest()

            embedding = embedding_generator.generate(
                text=unit.embedding_text,
                content_hash=content_hash,
            )

            # Attach embedding to unit metadata for downstream storage
            unit.metadata["embedding"] = embedding
            unit.metadata["embedding_version"] = EMBEDDING_VERSION

        except Exception:
            logger.exception(
                "Failed to generate embedding for retrieval unit",
                extra={
                    "retrieval_id": unit.retrieval_id,
                    "parent_element_id": unit.parent_element_id,
                },
            )


def _store_in_pgvector(
    retrieval_units: list[RetrievalUnit],
    course_id: str,
    module_id: str,
    file_id: str,
) -> None:
    """Store RetrievalUnits in pgvector with all metadata.

    Placeholder implementation — actual pgvector storage will be wired in CDK
    when database connectivity is configured via DB_SECRET_ARN and DB_PROXY_ENDPOINT.

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

        # Delete existing units for this file (incremental re-ingestion)
        cur.execute(
            "DELETE FROM retrieval_units WHERE metadata->>'file_id' = %s",
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
                    embedding, embedding_version, metadata, sibling_ids, ts_vector)
                   VALUES (%s, %s, %s, %s, %s::vector, %s, %s::jsonb, %s::jsonb,
                           to_tsvector('english', %s))
                   ON CONFLICT (retrieval_id) DO UPDATE SET
                    embedding_text = EXCLUDED.embedding_text,
                    embedding = EXCLUDED.embedding,
                    metadata = EXCLUDED.metadata,
                    sibling_ids = EXCLUDED.sibling_ids,
                    ts_vector = EXCLUDED.ts_vector""",
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


def _update_processing_status(file_id: str, module_id: str, chunk_count: int) -> None:
    """Update Module_Files.processing_status to 'complete' in RDS.

    This signals the frontend UI to stop showing the spinner.
    Best-effort: logs errors but never raises.

    Args:
        file_id: The file_id (from S3 key, i.e. filename without extension).
        module_id: The module this file belongs to.
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
        # Match by module_id and filename pattern (file_id is filename without extension)
        cur.execute(
            """UPDATE "Module_Files"
               SET processing_status = 'complete', chunk_count = %s, last_processed_at = NOW()
               WHERE module_id = %s AND filename = %s""",
            (chunk_count, module_id, file_id),
        )
        conn.commit()
        cur.close()
        conn.close()
        logger.info("Processing status updated to complete", extra={"file_id": file_id, "module_id": module_id})
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
        file_id: File identifier (filename without extension).
        module_id: Module identifier.
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
            modelId="anthropic.claude-3-haiku-20240307-v1:0",
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
        parsed["model"] = "anthropic.claude-3-haiku-20240307-v1:0"
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

        # Read existing metadata to merge
        cur.execute('SELECT metadata FROM "Module_Files" WHERE module_id = %s AND filename = %s', (module_id, file_id))
        row = cur.fetchone()
        existing = {}
        if row and row[0]:
            existing = row[0] if isinstance(row[0], dict) else json_mod.loads(row[0])

        existing["topic_extraction"] = parsed

        cur.execute(
            """UPDATE "Module_Files" SET metadata = %s::jsonb WHERE module_id = %s AND filename = %s""",
            (json_mod.dumps(existing), module_id, file_id),
        )
        conn.commit()
        cur.close()
        conn.close()

        logger.info(
            "Topic extraction complete",
            extra={"file_id": file_id, "topic_count": len(parsed["topics"]), "topics": parsed["topics"]},
        )

    except Exception:
        logger.exception("Topic extraction failed (best-effort)", extra={"file_id": file_id})
