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
from ..models.data_models import EMBEDDING_VERSION, QueryIntent, TypeCaps
from ..reasoning.context_builder import ContextBuilder
from ..reasoning.image_escalation import ImageEscalation
from ..reasoning.reasoning_engine import ReasoningEngine
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

# ---------------------------------------------------------------------------
# Service wiring (module-level singletons, initialized once per container)
# ---------------------------------------------------------------------------

_bedrock_client = boto3.client("bedrock-runtime")
_s3_client = boto3.client("s3")

_embedding_cache = EmbeddingCache()

# Layer 3 components
_query_analyzer = QueryAnalyzer(bedrock_client=_bedrock_client)
_cross_encoder_reranker = CrossEncoderReranker()
_production_ranker = ProductionRanker()

# Hybrid search requires vector/BM25 store backends.
# These are placeholder implementations that connect via DB_PROXY_ENDPOINT.
# In production, these are injected with real pgvector/BM25 clients.
_hybrid_search_engine: HybridSearchEngine | None = None

# Layer 4 components (sibling store wired lazily via _get_context_builder)
_context_builder = ContextBuilder()  # initialized without sibling_store at import time
_image_escalation = ImageEscalation(
    s3_client=_s3_client,
    bedrock_client=_bedrock_client,
    bucket_name=IR_BUCKET_NAME,
)
_reasoning_engine = ReasoningEngine(
    bedrock_client=_bedrock_client,
    context_builder=_context_builder,
    image_escalation=_image_escalation,
)


# ---------------------------------------------------------------------------
# Embedding generation for query
# ---------------------------------------------------------------------------

def _generate_query_embedding(query: str) -> list[float] | None:
    """Generate an embedding vector for the query.

    Uses Bedrock Titan Embed v2 directly (no caching for queries).

    Args:
        query: The user's search query.

    Returns:
        Embedding vector as list of floats, or None on failure.
    """
    import json

    try:
        request_body = json.dumps({"inputText": query, "dimensions": 1024})
        response = _bedrock_client.invoke_model(
            modelId="amazon.titan-embed-text-v2:0",
            body=request_body,
        )
        response_body = json.loads(response["body"].read())
        return response_body["embedding"]
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
        merged_results = _execute_hybrid_search(
            query=query,
            query_intent=query_intent,
            query_embedding=query_embedding,
            embedding_version=embedding_version,
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

    # Step 5: Cross-Encoder Reranking
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
            module_id=course_id,
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

    return _build_response(200, {
        "answer": reasoning_result.answer,
        "sources": reasoning_result.sources,
        "escalation_used": reasoning_result.escalation_used,
        "image_analyses": [
            {
                "image_s3_key": ia.image_s3_key,
                "analysis": ia.analysis,
                "confidence": ia.confidence,
            }
            for ia in reasoning_result.image_analyses
        ],
    })


def _execute_hybrid_search(
    query: str,
    query_intent: QueryIntent,
    query_embedding: list[float],
    embedding_version: str,
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

            if metadata_filter:
                for key, value in metadata_filter.items():
                    where_clauses.append(f"metadata->>'{key}' = %s")
                    params.append(str(value))

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

            if metadata_filter:
                for key, value in metadata_filter.items():
                    where_clauses.append(f"metadata->>'{key}' = %s")
                    params.append(str(value))

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


def _estimate_cost(query_intent: QueryIntent, result: Any) -> str:
    """Estimate the cost of processing this query.

    Rough estimation for logging/monitoring purposes.

    Args:
        query_intent: The query intent (determines if LLM calls were made).
        result: The reasoning result.

    Returns:
        Cost estimate string (e.g., "$0.003").
    """
    cost = 0.0

    # Query embedding: ~$0.0001
    cost += 0.0001

    # Query analysis: free if rules fired, ~$0.0001 if Haiku fallback
    # (Assume rule-based for now — worst case is +$0.0001)

    # Reasoning LLM: ~$0.002 for Haiku
    cost += 0.002

    # Image escalation: ~$0.001 per image
    if hasattr(result, "escalation_used") and result.escalation_used:
        image_count = len(result.image_analyses) if hasattr(result, "image_analyses") else 0
        cost += 0.001 * image_count

    return f"${cost:.4f}"
