"""HybridSearchEngine combines vector similarity and BM25 keyword search."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Protocol

from aws_lambda_powertools import Logger

from ..models.data_models import MergedResult, QueryIntent

logger = Logger(service="multimodal-rag-retrieval")

# Standard RRF constant
RRF_K = 60


class VectorStoreProtocol(Protocol):
    """Protocol for vector similarity search backends."""

    def search(
        self,
        query_embedding: list[float],
        k: int,
        embedding_version: str,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Search for similar vectors.

        Returns list of dicts with: retrieval_id, parent_element_id, content,
        element_type, score, metadata, sibling_ids.
        """
        ...


class BM25StoreProtocol(Protocol):
    """Protocol for BM25 keyword search backends."""

    def search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Search using BM25 keyword matching.

        Returns list of dicts with: retrieval_id, parent_element_id, content,
        element_type, score, metadata, sibling_ids.
        """
        ...


def _compute_rrf_scores(
    vector_results: list[dict],
    bm25_results: list[dict],
) -> list[MergedResult]:
    """Compute reciprocal rank fusion scores across vector and BM25 result lists.

    RRF formula: score = sum(1 / (k + rank)) across all lists where the item appears.
    k = 60 (standard constant).

    Args:
        vector_results: Ranked results from vector search.
        bm25_results: Ranked results from BM25 search.

    Returns:
        List of MergedResult sorted descending by rrf_score.
    """
    # Track scores and metadata per retrieval_id
    rrf_scores: dict[str, float] = {}
    vector_scores: dict[str, float] = {}
    keyword_scores: dict[str, float] = {}
    result_data: dict[str, dict] = {}

    # Process vector results
    for rank, result in enumerate(vector_results, start=1):
        rid = result["retrieval_id"]
        rrf_scores[rid] = rrf_scores.get(rid, 0.0) + 1.0 / (RRF_K + rank)
        vector_scores[rid] = result.get("score", 0.0)
        result_data[rid] = result

    # Process BM25 results
    for rank, result in enumerate(bm25_results, start=1):
        rid = result["retrieval_id"]
        rrf_scores[rid] = rrf_scores.get(rid, 0.0) + 1.0 / (RRF_K + rank)
        keyword_scores[rid] = result.get("score", 0.0)
        if rid not in result_data:
            result_data[rid] = result

    # Build MergedResult list
    merged: list[MergedResult] = []
    for rid, rrf_score in rrf_scores.items():
        data = result_data[rid]
        from ..models.data_models import ElementType

        # Convert element_type string to enum if needed
        element_type = data.get("element_type")
        if isinstance(element_type, str):
            element_type = ElementType(element_type)

        merged.append(
            MergedResult(
                retrieval_id=rid,
                parent_element_id=data.get("parent_element_id", ""),
                content=data.get("content", ""),
                element_type=element_type,
                rrf_score=rrf_score,
                vector_score=vector_scores.get(rid, 0.0),
                keyword_score=keyword_scores.get(rid, 0.0),
                metadata=data.get("metadata", {}),
                sibling_ids=data.get("sibling_ids", []),
            )
        )

    # Sort descending by RRF score
    merged.sort(key=lambda r: r.rrf_score, reverse=True)
    return merged


def _results_to_merged(results: list[dict], source: str) -> list[MergedResult]:
    """Convert raw search results to MergedResult when only one source is available.

    When only one search method returns results, RRF is skipped and we use
    the original scores directly.

    Args:
        results: Raw results from either vector or BM25 search.
        source: Either "vector" or "bm25" indicating the result source.

    Returns:
        List of MergedResult sorted descending by score.
    """
    from ..models.data_models import ElementType

    merged: list[MergedResult] = []
    for result in results:
        element_type = result.get("element_type")
        if isinstance(element_type, str):
            element_type = ElementType(element_type)

        score = result.get("score", 0.0)
        merged.append(
            MergedResult(
                retrieval_id=result["retrieval_id"],
                parent_element_id=result.get("parent_element_id", ""),
                content=result.get("content", ""),
                element_type=element_type,
                rrf_score=score,
                vector_score=score if source == "vector" else 0.0,
                keyword_score=score if source == "bm25" else 0.0,
                metadata=result.get("metadata", {}),
                sibling_ids=result.get("sibling_ids", []),
            )
        )

    merged.sort(key=lambda r: r.rrf_score, reverse=True)
    return merged


class HybridSearchEngine:
    """Performs hybrid search: vector + BM25 → reciprocal rank fusion.

    Features:
    - Parallel execution of vector and BM25 searches
    - 3x overfetch factor for better RRF merging
    - Embedding version filtering (only matching versions searched)
    - Metadata filtering (is_document_summary, lecture_number) for summary queries
    - Fallback: if filtered query returns zero results, retry without filter
    """

    def __init__(
        self,
        vector_store: VectorStoreProtocol,
        bm25_store: BM25StoreProtocol,
    ) -> None:
        """Initialize HybridSearchEngine with search backends.

        Args:
            vector_store: Backend for vector similarity search.
            bm25_store: Backend for BM25 keyword search.
        """
        self._vector_store = vector_store
        self._bm25_store = bm25_store

    def _build_metadata_filter(self, query_intent: QueryIntent) -> dict | None:
        """Build metadata filter from query intent.

        If query_intent.needs_summary and query_intent.lecture_number is not None,
        apply metadata filter: {is_document_summary: True, lecture_number: N}.

        Args:
            query_intent: The analyzed query intent.

        Returns:
            Metadata filter dict or None if no filter applies.
        """
        if query_intent.needs_summary and query_intent.lecture_number is not None:
            return {
                "is_document_summary": True,
                "lecture_number": query_intent.lecture_number,
            }
        return None

    def _execute_vector_search(
        self,
        query_embedding: list[float],
        k: int,
        embedding_version: str,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Execute vector similarity search with version and metadata filtering.

        Args:
            query_embedding: Pre-computed query embedding vector.
            k: Number of results to retrieve (overfetched).
            embedding_version: Only match vectors with this version.
            metadata_filter: Optional metadata filter for exact-match retrieval.

        Returns:
            List of result dicts from vector store.
        """
        try:
            return self._vector_store.search(
                query_embedding=query_embedding,
                k=k,
                embedding_version=embedding_version,
                metadata_filter=metadata_filter,
            )
        except Exception:
            logger.exception("Vector search failed")
            return []

    def _execute_bm25_search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        """Execute BM25 keyword search.

        Args:
            query: The user's search query.
            k: Number of results to retrieve (overfetched).
            metadata_filter: Optional metadata filter for exact-match retrieval.

        Returns:
            List of result dicts from BM25 store.
        """
        try:
            return self._bm25_store.search(
                query=query,
                k=k,
                metadata_filter=metadata_filter,
            )
        except Exception:
            logger.exception("BM25 search failed")
            return []

    def _merge_results(
        self,
        vector_results: list[dict],
        bm25_results: list[dict],
        k: int,
    ) -> list[MergedResult]:
        """Merge vector and BM25 results using the appropriate strategy.

        Cases:
        - Both return results → RRF merge
        - Only vector returns → use vector results directly (no RRF)
        - Only BM25 returns → use BM25 results directly (no RRF)
        - Both return zero → return empty list

        Args:
            vector_results: Results from vector search.
            bm25_results: Results from BM25 search.
            k: Maximum number of merged results to return.

        Returns:
            List of MergedResult, up to k items, sorted by score.
        """
        has_vector = len(vector_results) > 0
        has_bm25 = len(bm25_results) > 0

        if has_vector and has_bm25:
            # Both return results → RRF merge
            merged = _compute_rrf_scores(vector_results, bm25_results)
        elif has_vector:
            # Only vector returns → use directly, skip RRF
            merged = _results_to_merged(vector_results, source="vector")
        elif has_bm25:
            # Only BM25 returns → use directly, skip RRF
            merged = _results_to_merged(bm25_results, source="bm25")
        else:
            # Both return zero → empty result
            return []

        return merged[:k]

    def search(
        self,
        query: str,
        query_intent: QueryIntent,
        query_embedding: list[float] | None = None,
        k: int = 15,
        embedding_version: str = "",
        metadata_filter: dict | None = None,
    ) -> list[MergedResult]:
        """Execute hybrid search and merge results via reciprocal rank fusion.

        Executes vector search and BM25 search in parallel with 3x overfetch.
        Filters vector search to only matching embedding_version.
        Applies metadata filter for summary queries with lecture_number.
        Falls back to unfiltered search if filtered returns zero results.

        Args:
            query: The user's search query.
            query_intent: Structured intent from QueryAnalyzer.
            query_embedding: Pre-computed query embedding vector.
            k: Number of results to return (default 15).
            embedding_version: Only match vectors with this version.
            metadata_filter: Optional external metadata filter (e.g., module_id scoping).

        Returns:
            List of MergedResult sorted by RRF score, at most k items.
        """
        search_start = time.time()
        overfetch_k = k * 3
        intent_filter = self._build_metadata_filter(query_intent)
        # Merge external filter with intent-based filter
        combined_filter = {**(metadata_filter or {}), **(intent_filter or {})}

        logger.info(
            "Starting hybrid search",
            extra={
                "k": k,
                "overfetch_k": overfetch_k,
                "embedding_version": embedding_version,
                "has_metadata_filter": combined_filter is not None and len(combined_filter) > 0,
                "metadata_filter_keys": list(combined_filter.keys()) if combined_filter else [],
                "needs_summary": query_intent.needs_summary,
                "lecture_number": query_intent.lecture_number,
            },
        )

        # Execute vector and BM25 searches in parallel
        vector_results: list[dict] = []
        bm25_results: list[dict] = []
        vector_latency_ms = 0.0
        bm25_latency_ms = 0.0

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = {}

            if query_embedding is not None:
                futures["vector"] = executor.submit(
                    self._timed_vector_search,
                    query_embedding,
                    overfetch_k,
                    embedding_version,
                    combined_filter or None,
                )

            futures["bm25"] = executor.submit(
                self._timed_bm25_search,
                query,
                overfetch_k,
                combined_filter or None,
            )

            for key, future in futures.items():
                try:
                    result, latency = future.result()
                    if key == "vector":
                        vector_results = result
                        vector_latency_ms = latency
                    else:
                        bm25_results = result
                        bm25_latency_ms = latency
                except Exception:
                    logger.exception(
                        "Search future raised an exception",
                        extra={"search_backend": key},
                    )

        # Merge results
        merge_start = time.time()
        merged = self._merge_results(vector_results, bm25_results, k)
        merge_latency_ms = round((time.time() - merge_start) * 1000, 2)

        # Metadata filter fallback: if filtered query returns zero results,
        # retry WITHOUT the filter (Req 5.4, 5.5)
        used_fallback = False
        if len(merged) == 0 and combined_filter:
            logger.info(
                "Metadata-filtered search returned zero results, retrying without filter",
                extra={"metadata_filter": combined_filter},
            )
            used_fallback = True

            # Retry without metadata filter
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = {}

                if query_embedding is not None:
                    futures["vector"] = executor.submit(
                        self._timed_vector_search,
                        query_embedding,
                        overfetch_k,
                        embedding_version,
                        None,  # No metadata filter
                    )

                futures["bm25"] = executor.submit(
                    self._timed_bm25_search,
                    query,
                    overfetch_k,
                    None,  # No metadata filter
                )

                vector_results = []
                bm25_results = []

                for key, future in futures.items():
                    try:
                        result, latency = future.result()
                        if key == "vector":
                            vector_results = result
                            vector_latency_ms = latency
                        else:
                            bm25_results = result
                            bm25_latency_ms = latency
                    except Exception:
                        logger.exception(
                            "Search future raised during fallback",
                            extra={"search_backend": key},
                        )

            merged = self._merge_results(vector_results, bm25_results, k)

        total_latency_ms = round((time.time() - search_start) * 1000, 2)

        logger.info(
            "Hybrid search completed",
            extra={
                "vector_count": len(vector_results),
                "bm25_count": len(bm25_results),
                "merged_count": len(merged),
                "vector_latency_ms": vector_latency_ms,
                "bm25_latency_ms": bm25_latency_ms,
                "merge_latency_ms": merge_latency_ms,
                "total_search_latency_ms": total_latency_ms,
                "used_fallback": used_fallback,
                "top_rrf_score": round(merged[0].rrf_score, 5) if merged else 0,
            },
        )

        return merged

    def _timed_vector_search(
        self,
        query_embedding: list[float],
        k: int,
        embedding_version: str,
        metadata_filter: dict | None = None,
    ) -> tuple[list[dict], float]:
        """Execute vector search with timing."""
        start = time.time()
        results = self._execute_vector_search(query_embedding, k, embedding_version, metadata_filter)
        latency_ms = round((time.time() - start) * 1000, 2)
        return results, latency_ms

    def _timed_bm25_search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> tuple[list[dict], float]:
        """Execute BM25 search with timing."""
        start = time.time()
        results = self._execute_bm25_search(query, k, metadata_filter)
        latency_ms = round((time.time() - start) * 1000, 2)
        return results, latency_ms
