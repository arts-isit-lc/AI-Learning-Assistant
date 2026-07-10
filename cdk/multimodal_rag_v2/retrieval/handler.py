"""Retrieval + Reasoning Lambda handler.

Processes student queries through the full retrieval and reasoning pipeline:
  query → QueryAnalyzer → EmbeddingGenerator → HybridSearch → CrossEncoder →
  ProductionRanker → TypeCaps → ContextBuilder → ReasoningEngine → answer

Environment variables:
- EMBEDDING_CACHE_TABLE: DynamoDB table for embedding cache
- DB_SECRET_ARN: Secrets Manager ARN for database credentials
- DB_PROXY_ENDPOINT: RDS Proxy endpoint for pgvector
- IR_BUCKET_NAME: S3 bucket for images (escalation)

Error handling:
- pgvector unavailable → HTTP 503
- BM25 unavailable → vector-only fallback (handled by HybridSearchEngine)
- LLM failure → graceful fallback (handled by ReasoningEngine)
- Never raises unhandled exceptions

Requirements: 7.1, 8.1, 9.1, 10.1, 12.1, 12.2, 12.4, 12.5
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
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
from ..flags import QUERY_EMBEDDING_CACHE
from ..models.data_models import (
    ComparisonType,
    EMBEDDING_VERSION,
    ElementType,
    QueryIntent,
    TypeCaps,
    VisionMode,
)
from ..pricing import estimate_cost_usd
from ..reasoning.comparison.comparison_engine import ComparisonEngine
from ..reasoning.comparison.table_comparator import TableComparator
from ..reasoning.context_builder import ContextBuilder
from ..reasoning.formula.equivalence_checker import MathComputeEquivalenceChecker
from ..reasoning.formula.formula_comparator import FormulaComparator
from ..reasoning.image_escalation import ImageEscalation
from ..reasoning.reasoning_engine import ReasoningEngine
from ..reasoning.reference_resolver import FormulaReferenceResolver, TableReferenceResolver
from .cross_encoder_reranker import CrossEncoderReranker
from .hybrid_search_engine import HybridSearchEngine
from .production_ranker import ProductionRanker
from .query_analyzer import QueryAnalyzer

logger = Logger(service="multimodal-rag-retrieval", log_uncaught_exceptions=True)

# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------

EMBEDDING_CACHE_TABLE = os.environ.get("EMBEDDING_CACHE_TABLE", "")
DB_SECRET_ARN = os.environ.get("DB_SECRET_ARN", "")
DB_PROXY_ENDPOINT = os.environ.get("DB_PROXY_ENDPOINT", "")
IR_BUCKET_NAME = os.environ.get("IR_BUCKET_NAME", "")
# math_compute Lambda for Tier-2 symbolic formula equivalence. Optional: unset =>
# formula comparison runs lexical Tier 1 only (equivalence stays UNKNOWN).
MATH_COMPUTE_FUNCTION_NAME = os.environ.get("MATH_COMPUTE_FUNCTION_NAME", "")

# ---------------------------------------------------------------------------
# Service wiring (module-level singletons, initialized once per container)
# ---------------------------------------------------------------------------

_bedrock_client = boto3.client("bedrock-runtime")
_s3_client = boto3.client("s3")
_lambda_client = boto3.client("lambda")

_embedding_cache = EmbeddingCache()

# Layer 3 components
_query_analyzer = QueryAnalyzer(bedrock_client=_bedrock_client)
_cross_encoder_reranker = CrossEncoderReranker()
_production_ranker = ProductionRanker()

# Hybrid search backends (real pgvector + PostgreSQL FTS stores) are built
# lazily on first query via _create_vector_store() / _create_bm25_store().
_hybrid_search_engine: HybridSearchEngine | None = None

# Layer 4 components (sibling store wired lazily via _get_context_builder)
_context_builder = ContextBuilder()  # initialized without sibling_store at import time


def _get_db_connection():
    """Get a database connection for direct figure reference lookups.

    Reuses the same credentials as the vector/BM25 stores.
    Returns None if DB is not configured.
    """
    if not DB_PROXY_ENDPOINT or not DB_SECRET_ARN:
        return None
    try:
        import json as _json
        import psycopg2
        secrets_client = boto3.client("secretsmanager")
        secret = _json.loads(
            secrets_client.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"]
        )
        return psycopg2.connect(
            host=DB_PROXY_ENDPOINT,
            port=secret.get("port", 5432),
            dbname=secret.get("dbname", "aila"),
            user=secret.get("username"),
            password=secret.get("password"),
            sslmode="require",
            connect_timeout=10,
        )
    except Exception:
        logger.exception("Failed to create DB connection for image escalation")
        return None


_image_escalation = ImageEscalation(
    s3_client=_s3_client,
    bedrock_client=_bedrock_client,
    bucket_name=IR_BUCKET_NAME,
    db_connection_factory=_get_db_connection,
)
# Structured comparison engine, registry-keyed by ComparisonType.
# - TABLE: deterministic schema/shape/value diff (no Bedrock).
# - FORMULA: lexical Tier 1 diff, plus best-effort Tier 2 symbolic equivalence via
#   math_compute when MATH_COMPUTE_FUNCTION_NAME is set (else Tier 1 only).
_equivalence_checker = (
    MathComputeEquivalenceChecker(_lambda_client, MATH_COMPUTE_FUNCTION_NAME)
    if MATH_COMPUTE_FUNCTION_NAME
    else None
)
_comparison_engine = ComparisonEngine(
    resolvers={
        ComparisonType.TABLE: TableReferenceResolver(db_connection_factory=_get_db_connection),
        ComparisonType.FORMULA: FormulaReferenceResolver(db_connection_factory=_get_db_connection),
    },
    comparators={
        ComparisonType.TABLE: TableComparator(),
        ComparisonType.FORMULA: FormulaComparator(equivalence_checker=_equivalence_checker),
    },
)
_reasoning_engine = ReasoningEngine(
    bedrock_client=_bedrock_client,
    context_builder=_context_builder,
    image_escalation=_image_escalation,
    comparison_engine=_comparison_engine,
    # Cross-modal grounding resolves a referenced table to its structured content
    # (falls back to the top retrieved table when no numbered reference is given).
    table_resolver=TableReferenceResolver(db_connection_factory=_get_db_connection),
)


# ---------------------------------------------------------------------------
# Embedding generation for query
# ---------------------------------------------------------------------------

def _generate_query_embedding(query: str) -> list[float] | None:
    """Generate an embedding vector for the query (Titan Embed v2, 1024-d).

    When the ``QUERY_EMBEDDING_CACHE`` flag is enabled, identical/repeat queries
    are served from the DynamoDB EmbeddingCache (keyed by sha256(query) +
    EMBEDDING_VERSION) instead of re-calling Bedrock. Cache get/put are
    best-effort and never raise, so behavior is identical to the uncached path
    on any cache failure. Emits a ``bedrock_call`` log on a real embedding call
    for cost/latency measurement (Phase 0a).

    Args:
        query: The user's search query.

    Returns:
        Embedding vector as list of floats, or None on failure.
    """
    content_hash = (
        hashlib.sha256(query.encode("utf-8")).hexdigest()
        if QUERY_EMBEDDING_CACHE
        else ""
    )

    if QUERY_EMBEDDING_CACHE:
        cached = _embedding_cache.get(content_hash, EMBEDDING_VERSION)
        if cached is not None:
            logger.info(
                "Query embedding cache hit",
                extra={"event": "embedding_cache", "hit": True},
            )
            return cached

    try:
        request_body = json.dumps({"inputText": query, "dimensions": 1024})
        _t0 = time.perf_counter()
        response = _bedrock_client.invoke_model(
            modelId="amazon.titan-embed-text-v2:0",
            body=request_body,
        )
        _latency_ms = round((time.perf_counter() - _t0) * 1000, 2)
        response_body = json.loads(response["body"].read())
        embedding = response_body["embedding"]

        _in_tok = response_body.get("inputTextTokenCount", 0)
        logger.info(
            "Query embedding generated",
            extra={
                "event": "bedrock_call",
                "call": "query_embedding",
                "model_id": "amazon.titan-embed-text-v2:0",
                "input_tokens": _in_tok,
                "output_tokens": 0,
                "est_cost_usd": round(
                    estimate_cost_usd("amazon.titan-embed-text-v2:0", _in_tok, 0), 6
                ),
                "latency_ms": _latency_ms,
                "cache_enabled": QUERY_EMBEDDING_CACHE,
            },
        )

        if QUERY_EMBEDDING_CACHE:
            _embedding_cache.put(content_hash, embedding, EMBEDDING_VERSION)

        return embedding
    except Exception:
        logger.exception("Failed to generate query embedding")
        return None


# ---------------------------------------------------------------------------
# X-Ray subsegment helper
# ---------------------------------------------------------------------------

class _NoopContext:
    """No-op context manager for when X-Ray is not available."""

    def __enter__(self) -> "_NoopContext":
        return self

    def __exit__(self, *args: Any) -> None:
        pass


def _traced_subsegment(name: str) -> Any:
    """Return an X-Ray subsegment context manager, or a no-op if unavailable."""
    try:
        if xray_recorder:
            return xray_recorder.in_subsegment(name)
    except Exception:
        pass
    return _NoopContext()


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------

def _build_response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    """Build a standardized Lambda response."""
    return {
        "statusCode": status_code,
        "body": body,
    }


def _error_response(status_code: int, message: str) -> dict[str, Any]:
    """Build an error response."""
    return _build_response(status_code, {"error": message})


def _element_type_value(result: Any) -> str:
    """Return the element_type as a plain string (enum or str)."""
    et = result.element_type
    return et.value if hasattr(et, "value") else et


def _dedupe_by_retrieval_id(results: list) -> list:
    """Preserve order, dropping later duplicates by retrieval_id."""
    seen: set[str] = set()
    out: list = []
    for r in results:
        rid = getattr(r, "retrieval_id", None)
        if rid is not None and rid in seen:
            continue
        if rid is not None:
            seen.add(rid)
        out.append(r)
    return out


def _image_response_parts(
    reasoning_result, final_results: list
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build (wire image_analyses, image_results) for the response.

    Multi-image (MULTI) escalation resolves figures that may NOT be in the ranked
    results (a direct DB lookup). Union those into image_results (deduped) and derive
    the wire image_analyses from them so the chatbot can map/display each figure. The
    SINGLE path is UNCHANGED: reasoning_result.image_analyses is used verbatim and
    image_results is built from final_results only.
    """
    vision_analysis = getattr(reasoning_result, "vision_analysis", None)
    if vision_analysis is not None:
        source = _dedupe_by_retrieval_id(
            list(final_results) + list(vision_analysis.resolved_images)
        )
        wire = [
            {"image_s3_key": r.image_s3_key, "analysis": "", "confidence": vision_analysis.confidence}
            for r in vision_analysis.resolved_images
            if r.image_s3_key
        ]
        return wire, _build_image_results(source)

    wire = [
        {
            "image_s3_key": ia.image_s3_key,
            "analysis": ia.analysis,
            "confidence": ia.confidence,
        }
        for ia in reasoning_result.image_analyses
    ]
    return wire, _build_image_results(final_results)


def _build_image_results(final_results: list) -> list[dict[str, Any]]:
    """Structured IMAGE blocks for the client.

    Includes each image's caption-injected description (``content``) so the
    chatbot can ground the response text on the figure it will display. Without
    it, the response LLM sees no textual evidence of the figure and disclaims a
    figure that is simultaneously shown.
    """
    return [
        {
            "retrieval_id": r.retrieval_id,
            "score": r.score,
            "image_s3_key": r.image_s3_key,
            "page_num": r.metadata.get("provenance_page_num"),
            "module_id": r.metadata.get("module_id"),
            "element_type": r.element_type.value if hasattr(r.element_type, "value") else r.element_type,
            "description": r.content,
        }
        for r in final_results
        if r.image_s3_key
    ]


def _build_table_results(final_results: list) -> list[dict[str, Any]]:
    """Structured TABLE blocks for the client, deduped by parent element.

    A single table produces a summary unit plus one unit per column (all sharing
    a parent_element_id); we surface one structured entry per table, using the
    highest-scoring unit (final_results is already score-sorted).
    """
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in final_results:
        if _element_type_value(r) != "table" or r.parent_element_id in seen:
            continue
        seen.add(r.parent_element_id)
        out.append({
            "retrieval_id": r.retrieval_id,
            "score": r.score,
            "page_num": r.metadata.get("provenance_page_num") or r.metadata.get("page_num"),
            "module_id": r.metadata.get("module_id"),
            "headers": r.metadata.get("table_headers", []),
            "rows": r.metadata.get("table_rows", []),
            "summary": r.metadata.get("table_summary") or "",
            "content": r.content,
        })
    return out


def _resolved_results_for(reasoning_result, comparison_type) -> list:
    """Resolved RankedResults from a structured comparison of the given type.

    Returns [] unless a comparison of exactly ``comparison_type`` ran — so a
    formula comparison never leaks into table_results and vice versa.
    """
    sc = getattr(reasoning_result, "structured_comparison", None)
    if sc is None or getattr(sc, "comparison_type", None) != comparison_type:
        return []
    return list(getattr(sc, "resolved_results", []) or [])


def _grounding_resolved_results(reasoning_result, element_type) -> list:
    """RankedResults resolved by a CROSS_MODAL_GROUNDING call, for the given type.

    Routes each grounded artifact by its ``artifact_type`` so a grounded table
    lands in table_results (and, when a future type is added, a formula in
    formula_results). Returns [] unless a grounding call produced resolved
    artifacts of that type. A grounded reference may have been resolved by a
    direct DB lookup and thus be absent from ``final_results``, so surfacing it
    here is what puts the grounded table block in front of the student.
    """
    va = getattr(reasoning_result, "vision_analysis", None)
    if va is None or getattr(va, "mode", None) != VisionMode.CROSS_MODAL_GROUNDING:
        return []
    return [
        res.ranked_result
        for res in (getattr(va, "resolved_artifacts", None) or [])
        if res.artifact.artifact_type == element_type and res.ranked_result is not None
    ]


def _table_results_with_comparison(reasoning_result, final_results: list) -> list[dict[str, Any]]:
    """Build table_results, unioning tables resolved by a comparison OR grounding.

    A referent may be resolved by a direct DB lookup and thus absent from
    ``final_results``. Prepend resolved tables (authoritative) so BOTH a compared
    pair and a grounded table are surfaced. ``_build_table_results`` dedupes by
    ``parent_element_id`` (first wins), so a resolved table already in
    final_results is not duplicated.
    """
    resolved = _resolved_results_for(reasoning_result, ComparisonType.TABLE)
    resolved += _grounding_resolved_results(reasoning_result, ElementType.TABLE)
    if resolved:
        return _build_table_results(resolved + list(final_results))
    return _build_table_results(final_results)


def _formula_results_with_comparison(reasoning_result, final_results: list) -> list[dict[str, Any]]:
    """Build formula_results, unioning any formulas resolved by a formula comparison.

    Parallel to _table_results_with_comparison: prepend resolved formulas so both
    compared formulas are surfaced even when resolved by DB/top-k fallback.
    """
    resolved = _resolved_results_for(reasoning_result, ComparisonType.FORMULA)
    if resolved:
        return _build_formula_results(resolved + list(final_results))
    return _build_formula_results(final_results)


def _build_formula_results(final_results: list) -> list[dict[str, Any]]:
    """Structured FORMULA blocks for the client, deduped by parent element."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for r in final_results:
        if _element_type_value(r) != "formula" or r.parent_element_id in seen:
            continue
        seen.add(r.parent_element_id)
        out.append({
            "retrieval_id": r.retrieval_id,
            "score": r.score,
            "page_num": r.metadata.get("page_num") or r.metadata.get("provenance_page_num"),
            "module_id": r.metadata.get("module_id"),
            "latex": r.metadata.get("latex_repr") or r.content,
            "content": r.content,
        })
    return out


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

@logger.inject_lambda_context(clear_state=True)
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Retrieval + Reasoning Lambda handler.

    Processes a student query through the full retrieval and reasoning pipeline.

    Event format:
    {
        "query": "...",
        "session_id": "...",
        "course_id": "...",
        "allowed_file_ids": ["..."],
        "chat_history": [{"role": "user", "content": "..."}, ...],
        "embedding_version": "..."
    }

    Response format:
    {
        "statusCode": 200,
        "body": {
            "answer": "...",
            "sources": ["ret-id-1", ...],
            "escalation_used": false,
            "image_analyses": []
        }
    }

    Args:
        event: Request event with query and context parameters.
        context: Lambda context object.

    Returns:
        Response dict with statusCode and body.
    """
    query_id = str(uuid.uuid4())
    start_time = time.time()

    try:
        return _handle_query(event, query_id, start_time)
    except _PgvectorUnavailableError:
        logger.error(
            "pgvector unavailable — returning 503",
            extra={"query_id": query_id},
        )
        return _error_response(503, "Vector database is temporarily unavailable")
    except Exception:
        logger.exception(
            "Unhandled error in retrieval handler",
            extra={"query_id": query_id},
        )
        # Never raise unhandled exceptions — return graceful fallback
        return _build_response(200, {
            "answer": "I'm sorry, the service is temporarily unavailable. Please try again.",
            "sources": [],
            "escalation_used": False,
            "image_analyses": [],
        })


def _handle_query(
    event: dict[str, Any], query_id: str, start_time: float
) -> dict[str, Any]:
    """Internal query processing logic.

    Separated from handler to allow the outer handler to catch all exceptions.

    Args:
        event: Request event.
        query_id: Unique identifier for this query.
        start_time: Timestamp for latency tracking.

    Returns:
        Response dict.
    """
    # Step 1: Parse request
    query = event.get("query", "").strip()
    session_id = event.get("session_id", "")
    course_id = event.get("course_id", "")
    module_id = event.get("module_id", "")
    allowed_file_ids = event.get("allowed_file_ids", [])
    chat_history = event.get("chat_history", [])
    embedding_version = event.get("embedding_version", EMBEDDING_VERSION)

    if not query:
        return _error_response(400, "Query is required")

    logger.append_keys(
        query_id=query_id,
        session_id=session_id,
        course_id=course_id,
    )

    logger.info(
        "Processing retrieval query",
        extra={
            "query_length": len(query),
            "allowed_file_ids_count": len(allowed_file_ids),
            "chat_history_turns": len(chat_history),
            "embedding_version": embedding_version,
        },
    )

    # Step 2: Query Analysis
    with _traced_subsegment("QueryAnalysis"):
        analysis_start = time.time()
        query_intent = _query_analyzer.analyze(query)
        analysis_latency = time.time() - analysis_start

    logger.info(
        "Query analyzed",
        extra={
            "query_id": query_id,
            "needs_summary": query_intent.needs_summary,
            "requires_image": query_intent.requires_image,
            "requires_formula": query_intent.requires_formula,
            "requires_table": query_intent.requires_table,
            "requires_escalation": query_intent.requires_escalation,
            "lecture_number": query_intent.lecture_number,
            "analysis_latency_ms": round(analysis_latency * 1000, 2),
        },
    )

    # Step 3: Generate query embedding
    with _traced_subsegment("QueryEmbedding"):
        embed_start = time.time()
        query_embedding = _generate_query_embedding(query)
        embed_latency = time.time() - embed_start

    if query_embedding is None:
        # Cannot proceed without embedding — pgvector search requires it
        logger.error(
            "Query embedding generation failed — cannot proceed",
            extra={"query_id": query_id},
        )
        return _error_response(503, "Embedding service unavailable")

    logger.info(
        "Query embedding generated",
        extra={
            "query_id": query_id,
            "embed_latency_ms": round(embed_latency * 1000, 2),
        },
    )

    # Step 4: Hybrid Search
    with _traced_subsegment("HybridSearch"):
        search_start = time.time()
        # Scope selection: prefer the authoritative allowed_file_ids set (a module's
        # own files + its cross-module references). Fall back to module_id scoping
        # when the caller did not supply a file set.
        if allowed_file_ids:
            metadata_filter = {"file_id": allowed_file_ids}
            scope_kind = "file_id"
        elif module_id:
            metadata_filter = {"module_id": module_id}
            scope_kind = "module_id"
        else:
            metadata_filter = None
            scope_kind = "none"
        logger.info(
            "Retrieval scope selected",
            extra={
                "query_id": query_id,
                "scope_kind": scope_kind,
                "allowed_file_ids_count": len(allowed_file_ids),
            },
        )
        merged_results = _execute_hybrid_search(
            query=query,
            query_intent=query_intent,
            query_embedding=query_embedding,
            embedding_version=embedding_version,
            metadata_filter=metadata_filter,
        )
        search_latency = time.time() - search_start

    logger.info(
        "Hybrid search complete",
        extra={
            "query_id": query_id,
            "merged_result_count": len(merged_results),
            "search_latency_ms": round(search_latency * 1000, 2),
        },
    )

    # If no results found, return a helpful response
    if not merged_results:
        return _build_response(200, {
            "answer": "I couldn't find any relevant content for your question in the course materials.",
            "sources": [],
            "escalation_used": False,
            "image_analyses": [],
        })

    # Step 5: Cross-Encoder Reranking.
    # NOTE: no cross-encoder model is currently configured (_cross_encoder_reranker
    # is constructed without one), so this stage is intentionally an RRF-score
    # passthrough — it clamps scores, re-sorts by the existing RRF score, and
    # truncates to top_k. It is kept (cheap, pure-Python) as the integration point
    # for a future cross-encoder. Fallback behavior is covered by
    # TestFallbackBehavior in test_cross_encoder_reranker.py.
    with _traced_subsegment("CrossEncoderRerank"):
        rerank_start = time.time()
        ranked_results = _cross_encoder_reranker.rerank(
            query=query,
            results=merged_results,
            top_k=30,
        )
        rerank_latency = time.time() - rerank_start

    logger.info(
        "Cross-encoder reranking complete",
        extra={
            "query_id": query_id,
            "reranked_count": len(ranked_results),
            "rerank_latency_ms": round(rerank_latency * 1000, 2),
        },
    )

    # Step 6: Production Ranking + TypeCaps
    with _traced_subsegment("ProductionRanking"):
        rank_start = time.time()
        final_results = _production_ranker.rank(
            results=ranked_results,
            type_caps=TypeCaps(),
            query_intent=query_intent,
        )
        rank_latency = time.time() - rank_start

    logger.info(
        "Production ranking complete",
        extra={
            "query_id": query_id,
            "final_result_count": len(final_results),
            "rank_latency_ms": round(rank_latency * 1000, 2),
        },
    )

    # Step 7: Context Building
    with _traced_subsegment("ContextBuilding"):
        ctx_start = time.time()
        structured_context = _get_context_builder().build_context(
            results=final_results,
            module_id=module_id,
        )
        ctx_latency = time.time() - ctx_start

    logger.info(
        "Context built",
        extra={
            "query_id": query_id,
            "token_count": structured_context.token_count,
            "text_passages": len(structured_context.text_passages),
            "image_descriptions": len(structured_context.image_descriptions),
            "formula_results": len(structured_context.formula_results),
            "table_results": len(structured_context.table_results),
            "context_latency_ms": round(ctx_latency * 1000, 2),
        },
    )

    # Step 8: Reasoning Engine (with escalation if needed)
    with _traced_subsegment("ReasoningEngine"):
        reason_start = time.time()
        reasoning_result = _reasoning_engine.generate_answer(
            query=query,
            context=structured_context,
            chat_history=chat_history,
            ranked_results=final_results,
            query_intent=query_intent,
            scope_filter=metadata_filter,
        )
        reason_latency = time.time() - reason_start

    total_latency = time.time() - start_time

    # Step 9: Build and return response
    logger.info(
        "Query processing complete",
        extra={
            "query_id": query_id,
            "total_latency_ms": round(total_latency * 1000, 2),
            "analysis_latency_ms": round(analysis_latency * 1000, 2),
            "embed_latency_ms": round(embed_latency * 1000, 2),
            "search_latency_ms": round(search_latency * 1000, 2),
            "rerank_latency_ms": round(rerank_latency * 1000, 2),
            "rank_latency_ms": round(rank_latency * 1000, 2),
            "context_latency_ms": round(ctx_latency * 1000, 2),
            "reason_latency_ms": round(reason_latency * 1000, 2),
            "escalation_used": reasoning_result.escalation_used,
            "source_count": len(reasoning_result.sources),
            "cost_estimate": _estimate_cost(query_intent, reasoning_result),
        },
    )

    wire_image_analyses, image_results = _image_response_parts(reasoning_result, final_results)

    return _build_response(200, {
        "answer": reasoning_result.answer,
        "sources": reasoning_result.sources,
        "escalation_used": reasoning_result.escalation_used,
        "image_analyses": wire_image_analyses,
        "image_results": image_results,
        "table_results": _table_results_with_comparison(reasoning_result, final_results),
        "formula_results": _formula_results_with_comparison(reasoning_result, final_results),
    })


def _execute_hybrid_search(
    query: str,
    query_intent: QueryIntent,
    query_embedding: list[float],
    embedding_version: str,
    metadata_filter: dict | None = None,
) -> list:
    """Execute hybrid search, handling pgvector unavailability.

    If pgvector (vector store) is unavailable, returns HTTP 503.
    BM25 unavailability is handled gracefully by HybridSearchEngine
    (vector-only fallback).

    Args:
        query: The user's query.
        query_intent: Analyzed query intent.
        query_embedding: Pre-computed query embedding.
        embedding_version: Embedding version for filtering.
        metadata_filter: Optional dict for filtering results by metadata (e.g., module_id).

    Returns:
        List of MergedResult from hybrid search.

    Raises:
        _PgvectorUnavailableError: If pgvector is unavailable (caught by caller).
    """
    global _hybrid_search_engine

    if _hybrid_search_engine is None:
        # Initialize hybrid search with database-backed stores
        vector_store = _create_vector_store()
        bm25_store = _create_bm25_store()

        if vector_store is None:
            raise _PgvectorUnavailableError("pgvector is unavailable")

        _hybrid_search_engine = HybridSearchEngine(
            vector_store=vector_store,
            bm25_store=bm25_store,
        )

    try:
        # For figure/table/algorithm lookups, increase k to improve recall on exact references
        search_k = 25 if query_intent.requires_figure_lookup else 15

        return _hybrid_search_engine.search(
            query=query,
            query_intent=query_intent,
            query_embedding=query_embedding,
            k=search_k,
            embedding_version=embedding_version,
            metadata_filter=metadata_filter,
        )
    except _PgvectorUnavailableError:
        raise
    except Exception:
        logger.exception("Hybrid search encountered an unexpected error")
        raise _PgvectorUnavailableError("pgvector search failed")


class _PgvectorUnavailableError(Exception):
    """Raised when pgvector is unavailable during retrieval."""
    pass


def _create_vector_store() -> Any:
    """Create a pgvector-backed vector store client.

    Connects to the database via RDS Proxy using credentials from Secrets Manager.

    Returns:
        Vector store client implementing VectorStoreProtocol, or None if unavailable.
    """
    if not DB_PROXY_ENDPOINT or not DB_SECRET_ARN:
        logger.warning(
            "Vector store not configured (DB_PROXY_ENDPOINT or DB_SECRET_ARN missing)"
        )
        return None

    try:
        return _PgvectorStore(
            db_proxy_endpoint=DB_PROXY_ENDPOINT,
            db_secret_arn=DB_SECRET_ARN,
        )
    except Exception:
        logger.exception("Failed to create vector store")
        return None


def _create_bm25_store() -> Any:
    """Create a BM25 keyword search store client.

    Uses the same database connection as vector store.

    Returns:
        BM25 store client implementing BM25StoreProtocol.
    """
    if not DB_PROXY_ENDPOINT or not DB_SECRET_ARN:
        logger.warning(
            "BM25 store not configured (DB_PROXY_ENDPOINT or DB_SECRET_ARN missing)"
        )
        return _FallbackBM25Store()

    try:
        return _BM25Store(
            db_proxy_endpoint=DB_PROXY_ENDPOINT,
            db_secret_arn=DB_SECRET_ARN,
        )
    except Exception:
        logger.exception("Failed to create BM25 store, using fallback")
        return _FallbackBM25Store()


# Scope keys promoted to first-class indexed columns on retrieval_units.
# Cross-module file referencing filters on these directly (indexed) instead of
# extracting from the metadata JSON.
_COLUMN_SCOPE_KEYS = {"file_id", "module_id"}


def _append_metadata_filter(
    where_clauses: list, params: list, metadata_filter: dict | None
) -> None:
    """Append WHERE clauses + params for a metadata/scope filter.

    - Promoted keys (file_id, module_id) filter on first-class indexed columns;
      all other keys (e.g. is_document_summary, lecture_number) use metadata->>'key'.
    - List/tuple values produce `= ANY(%s)` (psycopg2 adapts the list to an array);
      scalar values produce `= %s`.
    """
    if not metadata_filter:
        return
    for key, value in metadata_filter.items():
        col = key if key in _COLUMN_SCOPE_KEYS else f"metadata->>'{key}'"
        if isinstance(value, (list, tuple)):
            where_clauses.append(f"{col} = ANY(%s)")
            params.append([str(v) for v in value])
        elif isinstance(value, bool):
            # JSONB stores booleans as lowercase 'true'/'false'. str(True) is
            # 'True', which never matches metadata->>'key' (M8). Compare against
            # the JSON text form instead.
            where_clauses.append(f"{col} = %s")
            params.append("true" if value else "false")
        else:
            where_clauses.append(f"{col} = %s")
            params.append(str(value))


class _PgvectorStore:
    """pgvector-backed vector similarity search.

    Connects to RDS via Proxy with sslmode=require.
    Implements VectorStoreProtocol.
    """

    def __init__(self, db_proxy_endpoint: str, db_secret_arn: str) -> None:
        self._endpoint = db_proxy_endpoint
        self._secret_arn = db_secret_arn
        self._connection = None

    def _get_connection(self) -> Any:
        """Get or create a database connection."""
        if self._connection is None:
            import json
            secrets_client = boto3.client("secretsmanager")
            secret_response = secrets_client.get_secret_value(SecretId=self._secret_arn)
            secret = json.loads(secret_response["SecretString"])

            import psycopg2
            self._connection = psycopg2.connect(
                host=self._endpoint,
                port=secret.get("port", 5432),
                dbname=secret.get("dbname", "aila"),
                user=secret.get("username"),
                password=secret.get("password"),
                sslmode="require",
                connect_timeout=10,
            )
        return self._connection

    def search(
        self,
        query_embedding: list[float],
        k: int,
        embedding_version: str,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Search for similar vectors using pgvector cosine distance.

        Args:
            query_embedding: Query embedding vector.
            k: Number of results to return.
            embedding_version: Only match vectors with this version.
            metadata_filter: Optional metadata filter for exact-match retrieval.

        Returns:
            List of result dicts matching VectorStoreProtocol.

        Raises:
            _PgvectorUnavailableError: On connection failure.
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            # Build query with version filter and optional metadata filter
            embedding_str = f"[{','.join(str(v) for v in query_embedding)}]"

            where_clauses = ["embedding_version = %s"]
            params: list[Any] = [embedding_version]

            _append_metadata_filter(where_clauses, params, metadata_filter)

            where_sql = " AND ".join(where_clauses)

            sql = f"""
                SELECT retrieval_id, parent_element_id, embedding_text,
                       element_type, 1 - (embedding <=> %s::vector) AS score,
                       metadata, sibling_ids
                FROM retrieval_units
                WHERE {where_sql}
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """

            params = [embedding_str] + params + [embedding_str, k]
            cursor.execute(sql, params)

            results = []
            for row in cursor.fetchall():
                import json as _json
                results.append({
                    "retrieval_id": row[0],
                    "parent_element_id": row[1],
                    "content": row[2],
                    "element_type": row[3],
                    "score": float(row[4]),
                    "metadata": _json.loads(row[5]) if isinstance(row[5], str) else (row[5] or {}),
                    "sibling_ids": _json.loads(row[6]) if isinstance(row[6], str) else (row[6] or []),
                })

            cursor.close()
            return results

        except Exception as exc:
            logger.exception("pgvector search failed")
            # Reset connection for next attempt
            self._connection = None
            raise _PgvectorUnavailableError(
                f"pgvector search failed: {type(exc).__name__}"
            ) from exc


class _BM25Store:
    """BM25 keyword search backed by PostgreSQL full-text search.

    Implements BM25StoreProtocol.
    """

    def __init__(self, db_proxy_endpoint: str, db_secret_arn: str) -> None:
        self._endpoint = db_proxy_endpoint
        self._secret_arn = db_secret_arn
        self._connection = None

    def _get_connection(self) -> Any:
        """Get or create a database connection."""
        if self._connection is None:
            import json
            secrets_client = boto3.client("secretsmanager")
            secret_response = secrets_client.get_secret_value(SecretId=self._secret_arn)
            secret = json.loads(secret_response["SecretString"])

            import psycopg2
            self._connection = psycopg2.connect(
                host=self._endpoint,
                port=secret.get("port", 5432),
                dbname=secret.get("dbname", "aila"),
                user=secret.get("username"),
                password=secret.get("password"),
                sslmode="require",
                connect_timeout=10,
            )
        return self._connection

    def search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Search using PostgreSQL full-text search as BM25 approximation.

        Args:
            query: The user's search query.
            k: Number of results to return.
            metadata_filter: Optional metadata filter for exact-match retrieval.

        Returns:
            List of result dicts matching BM25StoreProtocol.
        """
        try:
            conn = self._get_connection()
            cursor = conn.cursor()

            where_clauses = ["ts_vector @@ plainto_tsquery('english', %s)"]
            params: list[Any] = [query]

            _append_metadata_filter(where_clauses, params, metadata_filter)

            where_sql = " AND ".join(where_clauses)

            sql = f"""
                SELECT retrieval_id, parent_element_id, embedding_text,
                       element_type, ts_rank(ts_vector, plainto_tsquery('english', %s)) AS score,
                       metadata, sibling_ids
                FROM retrieval_units
                WHERE {where_sql}
                ORDER BY score DESC
                LIMIT %s
            """

            params = [query] + params + [k]
            cursor.execute(sql, params)

            results = []
            for row in cursor.fetchall():
                import json as _json
                results.append({
                    "retrieval_id": row[0],
                    "parent_element_id": row[1],
                    "content": row[2],
                    "element_type": row[3],
                    "score": float(row[4]),
                    "metadata": _json.loads(row[5]) if isinstance(row[5], str) else (row[5] or {}),
                    "sibling_ids": _json.loads(row[6]) if isinstance(row[6], str) else (row[6] or []),
                })

            cursor.close()
            return results

        except Exception:
            logger.exception("BM25 search failed")
            self._connection = None
            # BM25 unavailability is non-fatal — return empty and let
            # HybridSearchEngine handle vector-only fallback
            return []


class _FallbackBM25Store:
    """Fallback BM25 store that returns empty results.

    Used when BM25 backend is unavailable. HybridSearchEngine handles
    the vector-only fallback path.
    """

    def search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Always returns empty results (BM25 unavailable fallback)."""
        return []


class _SiblingStore:
    """Fetches retrieval units by ID for sibling expansion.

    Implements the SiblingStoreProtocol expected by ContextBuilder.
    """

    def __init__(self, db_proxy_endpoint: str, db_secret_arn: str) -> None:
        self._endpoint = db_proxy_endpoint
        self._secret_arn = db_secret_arn
        self._connection = None

    def _get_connection(self):
        if self._connection is None:
            import json as _json
            import psycopg2
            secrets_client = boto3.client("secretsmanager")
            secret = _json.loads(
                secrets_client.get_secret_value(SecretId=self._secret_arn)["SecretString"]
            )
            self._connection = psycopg2.connect(
                host=self._endpoint,
                port=secret.get("port", 5432),
                dbname=secret.get("dbname", "aila"),
                user=secret.get("username"),
                password=secret.get("password"),
                sslmode="require",
                connect_timeout=10,
            )
        return self._connection

    def get_by_ids(self, retrieval_ids: list[str]) -> list:
        """Fetch RankedResult objects by retrieval_id.

        Args:
            retrieval_ids: List of retrieval_ids to fetch.

        Returns:
            List of RankedResult-like objects with content and metadata.
        """
        if not retrieval_ids:
            return []

        try:
            import json as _json
            conn = self._get_connection()
            cursor = conn.cursor()

            # Use ANY array to fetch multiple IDs in one query
            cursor.execute(
                """SELECT retrieval_id, parent_element_id, embedding_text,
                          element_type, metadata, sibling_ids
                   FROM retrieval_units
                   WHERE retrieval_id = ANY(%s)""",
                (retrieval_ids,),
            )

            results = []
            for row in cursor.fetchall():
                metadata = _json.loads(row[4]) if isinstance(row[4], str) else (row[4] or {})
                sibling_ids = _json.loads(row[5]) if isinstance(row[5], str) else (row[5] or [])

                from ..models.data_models import ElementType, RankedResult
                results.append(RankedResult(
                    retrieval_id=row[0],
                    parent_element_id=row[1],
                    content=row[2],
                    element_type=ElementType(row[3]) if row[3] else ElementType.TEXT,
                    score=0.0,  # siblings don't have independent scores
                    cross_encoder_score=0.0,
                    metadata_boost=0.0,
                    metadata=metadata,
                    image_s3_key=metadata.get("image_s3_key"),
                    sibling_ids=sibling_ids,
                ))

            cursor.close()
            return results

        except Exception:
            logger.exception("Sibling store fetch failed")
            return []


def _get_context_builder() -> ContextBuilder:
    """Get or upgrade ContextBuilder with sibling store on first call.

    The ContextBuilder is created at module import without a sibling_store
    (to avoid forward-reference issues). On first call, we attach a _SiblingStore.
    """
    global _context_builder
    if _context_builder._sibling_store is None:
        db_proxy = os.environ.get("DB_PROXY_ENDPOINT", "")
        db_secret = os.environ.get("DB_SECRET_ARN", "")
        if db_proxy and db_secret:
            _context_builder._sibling_store = _SiblingStore(
                db_proxy_endpoint=db_proxy,
                db_secret_arn=db_secret,
            )
    return _context_builder


# Representative token counts for the COARSE _estimate_cost summary only.
# Real per-call costs are emitted as "bedrock_call" structured log events.
_COARSE_QUERY_TOKENS = 30
_COARSE_REASONING_INPUT_TOKENS = 6000
_COARSE_REASONING_OUTPUT_TOKENS = 800
_COARSE_VISION_INPUT_TOKENS = 1600
_COARSE_VISION_OUTPUT_TOKENS = 400
_HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
_EMBED_MODEL_ID = "amazon.titan-embed-text-v2:0"


def _estimate_cost(query_intent: QueryIntent, result: Any) -> str:
    """Coarse per-query cost summary for the response payload.

    NOTE: This is a rough at-a-glance estimate that uses representative token
    counts together with the shared pricing table. The AUTHORITATIVE per-request
    cost is reconstructed from the structured ``bedrock_call`` log events (which
    carry the real token counts for each call) via CloudWatch Logs Insights.

    Args:
        query_intent: The query intent (reserved for future per-intent tuning).
        result: The reasoning result (used to count escalation vision calls).

    Returns:
        Cost estimate string (e.g., "$0.0042").
    """
    # Query embedding (Titan, input-only, short query).
    cost = estimate_cost_usd(_EMBED_MODEL_ID, _COARSE_QUERY_TOKENS, 0)

    # Reasoning answer generation (Haiku).
    cost += estimate_cost_usd(
        _HAIKU_MODEL_ID, _COARSE_REASONING_INPUT_TOKENS, _COARSE_REASONING_OUTPUT_TOKENS
    )

    # Image escalation (Haiku vision), per analyzed image.
    if getattr(result, "escalation_used", False):
        image_count = len(getattr(result, "image_analyses", []) or [])
        cost += image_count * estimate_cost_usd(
            _HAIKU_MODEL_ID, _COARSE_VISION_INPUT_TOKENS, _COARSE_VISION_OUTPUT_TOKENS
        )

    return f"${cost:.4f}"
