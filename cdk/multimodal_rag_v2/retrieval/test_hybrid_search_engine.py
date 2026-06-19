"""Unit tests for HybridSearchEngine — vector + BM25 hybrid search with RRF."""

from __future__ import annotations

from typing import Any

import pytest

from ..models.data_models import ElementType, MergedResult, QueryIntent
from .hybrid_search_engine import (
    HybridSearchEngine,
    _compute_rrf_scores,
    _results_to_merged,
    RRF_K,
)


# ---------------------------------------------------------------------------
# Fake stores for testing
# ---------------------------------------------------------------------------


class FakeVectorStore:
    """In-memory vector store for testing."""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results = results or []
        self.call_count = 0
        self.last_kwargs: dict[str, Any] = {}

    def search(
        self,
        query_embedding: list[float],
        k: int,
        embedding_version: str,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        self.call_count += 1
        self.last_kwargs = {
            "query_embedding": query_embedding,
            "k": k,
            "embedding_version": embedding_version,
            "metadata_filter": metadata_filter,
        }
        return self._results


class FakeBM25Store:
    """In-memory BM25 store for testing."""

    def __init__(self, results: list[dict] | None = None) -> None:
        self._results = results or []
        self.call_count = 0
        self.last_kwargs: dict[str, Any] = {}

    def search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        self.call_count += 1
        self.last_kwargs = {
            "query": query,
            "k": k,
            "metadata_filter": metadata_filter,
        }
        return self._results


class ErrorVectorStore:
    """Vector store that raises an exception on search."""

    def search(self, **kwargs: Any) -> list[dict]:
        raise ConnectionError("pgvector unavailable")


class ErrorBM25Store:
    """BM25 store that raises an exception on search."""

    def search(self, **kwargs: Any) -> list[dict]:
        raise ConnectionError("BM25 unavailable")


# ---------------------------------------------------------------------------
# Helper to build result dicts
# ---------------------------------------------------------------------------


def _make_result(
    retrieval_id: str,
    score: float = 0.5,
    element_type: str = "text",
    content: str = "test content",
    parent_element_id: str = "parent-1",
    metadata: dict | None = None,
    sibling_ids: list[str] | None = None,
) -> dict:
    return {
        "retrieval_id": retrieval_id,
        "parent_element_id": parent_element_id,
        "content": content,
        "element_type": element_type,
        "score": score,
        "metadata": metadata or {},
        "sibling_ids": sibling_ids or [],
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def default_intent() -> QueryIntent:
    return QueryIntent()


@pytest.fixture
def summary_intent() -> QueryIntent:
    return QueryIntent(needs_summary=True, lecture_number=7)


@pytest.fixture
def summary_intent_no_lecture() -> QueryIntent:
    return QueryIntent(needs_summary=True, lecture_number=None)


@pytest.fixture
def query_embedding() -> list[float]:
    return [0.1] * 1024


# ---------------------------------------------------------------------------
# Tests for RRF computation
# ---------------------------------------------------------------------------


class TestComputeRRFScores:
    def test_single_result_from_both_lists(self) -> None:
        """Same item in both lists gets RRF from both ranks."""
        vec = [_make_result("r1", score=0.9)]
        bm25 = [_make_result("r1", score=0.8)]

        merged = _compute_rrf_scores(vec, bm25)

        assert len(merged) == 1
        assert merged[0].retrieval_id == "r1"
        expected_score = 1.0 / (RRF_K + 1) + 1.0 / (RRF_K + 1)
        assert merged[0].rrf_score == pytest.approx(expected_score)

    def test_disjoint_results(self) -> None:
        """Items only in one list get RRF score from that list only."""
        vec = [_make_result("r1", score=0.9)]
        bm25 = [_make_result("r2", score=0.8)]

        merged = _compute_rrf_scores(vec, bm25)

        assert len(merged) == 2
        # Both should have score = 1/(60+1) since they're rank 1 in their list
        for r in merged:
            assert r.rrf_score == pytest.approx(1.0 / (RRF_K + 1))

    def test_ranking_order_respects_rrf(self) -> None:
        """Item appearing in both lists ranked higher than single-list items."""
        vec = [_make_result("r1", score=0.9), _make_result("r2", score=0.7)]
        bm25 = [_make_result("r1", score=0.8), _make_result("r3", score=0.6)]

        merged = _compute_rrf_scores(vec, bm25)

        assert merged[0].retrieval_id == "r1"  # highest RRF (in both)
        # r2 and r3 have same RRF (both rank 2 in one list)
        remaining_ids = {m.retrieval_id for m in merged[1:]}
        assert remaining_ids == {"r2", "r3"}

    def test_preserves_vector_and_keyword_scores(self) -> None:
        """Original scores from vector and BM25 are preserved."""
        vec = [_make_result("r1", score=0.95)]
        bm25 = [_make_result("r1", score=0.85)]

        merged = _compute_rrf_scores(vec, bm25)

        assert merged[0].vector_score == pytest.approx(0.95)
        assert merged[0].keyword_score == pytest.approx(0.85)

    def test_preserves_metadata_and_sibling_ids(self) -> None:
        """Metadata and sibling_ids from result data are preserved."""
        vec = [_make_result("r1", metadata={"page": 3}, sibling_ids=["s1", "s2"])]
        bm25: list[dict] = []

        merged = _compute_rrf_scores(vec, bm25)

        assert merged[0].metadata == {"page": 3}
        assert merged[0].sibling_ids == ["s1", "s2"]

    def test_element_type_string_converted_to_enum(self) -> None:
        """String element_type values are converted to ElementType enum."""
        vec = [_make_result("r1", element_type="image")]
        bm25: list[dict] = []

        merged = _compute_rrf_scores(vec, bm25)

        assert merged[0].element_type == ElementType.IMAGE


# ---------------------------------------------------------------------------
# Tests for _results_to_merged (single-source conversion)
# ---------------------------------------------------------------------------


class TestResultsToMerged:
    def test_vector_source_sets_vector_score(self) -> None:
        results = [_make_result("r1", score=0.8)]
        merged = _results_to_merged(results, source="vector")

        assert merged[0].vector_score == pytest.approx(0.8)
        assert merged[0].keyword_score == pytest.approx(0.0)

    def test_bm25_source_sets_keyword_score(self) -> None:
        results = [_make_result("r1", score=0.7)]
        merged = _results_to_merged(results, source="bm25")

        assert merged[0].keyword_score == pytest.approx(0.7)
        assert merged[0].vector_score == pytest.approx(0.0)

    def test_sorted_descending_by_score(self) -> None:
        results = [
            _make_result("r1", score=0.5),
            _make_result("r2", score=0.9),
            _make_result("r3", score=0.7),
        ]
        merged = _results_to_merged(results, source="vector")

        scores = [m.rrf_score for m in merged]
        assert scores == sorted(scores, reverse=True)


# ---------------------------------------------------------------------------
# Tests for HybridSearchEngine.search() — overfetch
# ---------------------------------------------------------------------------


class TestOverfetch:
    def test_overfetch_3x_applied(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Both stores receive k * 3 as the requested result count."""
        vec_store = FakeVectorStore(results=[_make_result("r1")])
        bm25_store = FakeBM25Store(results=[_make_result("r2")])
        engine = HybridSearchEngine(vec_store, bm25_store)

        engine.search(
            query="test query",
            query_intent=default_intent,
            query_embedding=query_embedding,
            k=10,
            embedding_version="titan-v2-1024",
        )

        assert vec_store.last_kwargs["k"] == 30  # 10 * 3
        assert bm25_store.last_kwargs["k"] == 30

    def test_default_k_15_overfetch_45(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Default k=15 yields overfetch of 45."""
        vec_store = FakeVectorStore(results=[])
        bm25_store = FakeBM25Store(results=[])
        engine = HybridSearchEngine(vec_store, bm25_store)

        engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert vec_store.last_kwargs["k"] == 45
        assert bm25_store.last_kwargs["k"] == 45


# ---------------------------------------------------------------------------
# Tests for embedding version filter (Req 8.7)
# ---------------------------------------------------------------------------


class TestEmbeddingVersionFilter:
    def test_embedding_version_passed_to_vector_store(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Vector store receives the embedding_version for filtering."""
        vec_store = FakeVectorStore(results=[])
        bm25_store = FakeBM25Store(results=[])
        engine = HybridSearchEngine(vec_store, bm25_store)

        engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="titan-v2-1024",
        )

        assert vec_store.last_kwargs["embedding_version"] == "titan-v2-1024"


# ---------------------------------------------------------------------------
# Tests for metadata filtering (Req 5.4, 5.5)
# ---------------------------------------------------------------------------


class TestMetadataFiltering:
    def test_summary_intent_with_lecture_applies_filter(
        self, summary_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """needs_summary + lecture_number → metadata filter applied."""
        vec_store = FakeVectorStore(results=[_make_result("r1")])
        bm25_store = FakeBM25Store(results=[_make_result("r1")])
        engine = HybridSearchEngine(vec_store, bm25_store)

        engine.search(
            query="what is covered in lecture 7",
            query_intent=summary_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        expected_filter = {"is_document_summary": True, "lecture_number": 7}
        assert vec_store.last_kwargs["metadata_filter"] == expected_filter
        assert bm25_store.last_kwargs["metadata_filter"] == expected_filter

    def test_summary_intent_without_lecture_no_filter(
        self, summary_intent_no_lecture: QueryIntent, query_embedding: list[float]
    ) -> None:
        """needs_summary without lecture_number → no metadata filter."""
        vec_store = FakeVectorStore(results=[])
        bm25_store = FakeBM25Store(results=[])
        engine = HybridSearchEngine(vec_store, bm25_store)

        engine.search(
            query="overview of the course",
            query_intent=summary_intent_no_lecture,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert vec_store.last_kwargs["metadata_filter"] is None
        assert bm25_store.last_kwargs["metadata_filter"] is None

    def test_non_summary_intent_no_filter(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Regular intent → no metadata filter."""
        vec_store = FakeVectorStore(results=[])
        bm25_store = FakeBM25Store(results=[])
        engine = HybridSearchEngine(vec_store, bm25_store)

        engine.search(
            query="what is a derivative",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert vec_store.last_kwargs["metadata_filter"] is None
        assert bm25_store.last_kwargs["metadata_filter"] is None


# ---------------------------------------------------------------------------
# Tests for metadata filter fallback (Req 5.4, 5.5)
# ---------------------------------------------------------------------------


class TestMetadataFilterFallback:
    def test_fallback_retries_without_filter(
        self, query_embedding: list[float]
    ) -> None:
        """If filtered search returns zero, retry without metadata filter."""
        # First call with filter → empty; second without filter → results
        call_count = {"vector": 0, "bm25": 0}

        class ConditionalVectorStore:
            def search(self, query_embedding, k, embedding_version, metadata_filter=None):
                call_count["vector"] += 1
                if metadata_filter is not None:
                    return []  # Filtered → no results
                return [_make_result("r1", score=0.8)]

        class ConditionalBM25Store:
            def search(self, query, k, metadata_filter=None):
                call_count["bm25"] += 1
                if metadata_filter is not None:
                    return []  # Filtered → no results
                return [_make_result("r2", score=0.7)]

        intent = QueryIntent(needs_summary=True, lecture_number=5)
        engine = HybridSearchEngine(ConditionalVectorStore(), ConditionalBM25Store())

        results = engine.search(
            query="what is in lecture 5",
            query_intent=intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        # Should have called each store twice (filtered + unfiltered)
        assert call_count["vector"] == 2
        assert call_count["bm25"] == 2
        # Should return results from the fallback
        assert len(results) > 0

    def test_no_fallback_when_filter_returns_results(
        self, query_embedding: list[float]
    ) -> None:
        """If filtered search returns results, no fallback is triggered."""
        vec_store = FakeVectorStore(results=[_make_result("r1")])
        bm25_store = FakeBM25Store(results=[_make_result("r2")])

        intent = QueryIntent(needs_summary=True, lecture_number=3)
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="lecture 3 topics",
            query_intent=intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        # Each store called only once
        assert vec_store.call_count == 1
        assert bm25_store.call_count == 1
        assert len(results) > 0


# ---------------------------------------------------------------------------
# Tests for merge cases (Req 8.9, 8.10)
# ---------------------------------------------------------------------------


class TestMergeCases:
    def test_both_return_results_rrf_merge(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Both vector and BM25 return results → RRF merge."""
        vec_store = FakeVectorStore(
            results=[_make_result("r1", score=0.9), _make_result("r2", score=0.7)]
        )
        bm25_store = FakeBM25Store(
            results=[_make_result("r1", score=0.8), _make_result("r3", score=0.6)]
        )
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert len(results) == 3
        # r1 should be highest (appears in both lists)
        assert results[0].retrieval_id == "r1"

    def test_only_vector_returns_results(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Only vector returns results → use vector directly, no RRF."""
        vec_store = FakeVectorStore(
            results=[_make_result("r1", score=0.9), _make_result("r2", score=0.7)]
        )
        bm25_store = FakeBM25Store(results=[])
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert len(results) == 2
        assert results[0].retrieval_id == "r1"
        assert results[0].vector_score == pytest.approx(0.9)
        assert results[0].keyword_score == pytest.approx(0.0)

    def test_only_bm25_returns_results(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Only BM25 returns results → use BM25 directly, no RRF."""
        vec_store = FakeVectorStore(results=[])
        bm25_store = FakeBM25Store(
            results=[_make_result("r1", score=0.8), _make_result("r2", score=0.6)]
        )
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert len(results) == 2
        assert results[0].retrieval_id == "r1"
        assert results[0].keyword_score == pytest.approx(0.8)
        assert results[0].vector_score == pytest.approx(0.0)

    def test_both_return_zero_empty_result(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Both return zero results → empty list returned."""
        vec_store = FakeVectorStore(results=[])
        bm25_store = FakeBM25Store(results=[])
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="nonexistent query",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert results == []


# ---------------------------------------------------------------------------
# Tests for result count limiting (returns at most k)
# ---------------------------------------------------------------------------


class TestResultCountLimit:
    def test_returns_at_most_k_results(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Merged results are capped at k."""
        many_results = [_make_result(f"r{i}", score=1.0 - i * 0.01) for i in range(20)]
        vec_store = FakeVectorStore(results=many_results)
        bm25_store = FakeBM25Store(results=many_results)
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            k=5,
            embedding_version="v1",
        )

        assert len(results) <= 5


# ---------------------------------------------------------------------------
# Tests for error handling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    def test_vector_store_error_continues_with_bm25(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """If vector store fails, BM25 results used alone."""
        vec_store = ErrorVectorStore()
        bm25_store = FakeBM25Store(
            results=[_make_result("r1", score=0.7)]
        )
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert len(results) == 1
        assert results[0].retrieval_id == "r1"

    def test_bm25_store_error_continues_with_vector(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """If BM25 store fails, vector results used alone."""
        vec_store = FakeVectorStore(
            results=[_make_result("r1", score=0.9)]
        )
        bm25_store = ErrorBM25Store()
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert len(results) == 1
        assert results[0].retrieval_id == "r1"

    def test_both_stores_error_returns_empty(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """If both stores fail, empty list returned."""
        engine = HybridSearchEngine(ErrorVectorStore(), ErrorBM25Store())

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=query_embedding,
            embedding_version="v1",
        )

        assert results == []


# ---------------------------------------------------------------------------
# Tests for no embedding (BM25 only)
# ---------------------------------------------------------------------------


class TestNoEmbedding:
    def test_no_query_embedding_skips_vector_search(
        self, default_intent: QueryIntent
    ) -> None:
        """When query_embedding is None, only BM25 search is executed."""
        vec_store = FakeVectorStore(results=[_make_result("r1")])
        bm25_store = FakeBM25Store(results=[_make_result("r2", score=0.7)])
        engine = HybridSearchEngine(vec_store, bm25_store)

        results = engine.search(
            query="test",
            query_intent=default_intent,
            query_embedding=None,
            embedding_version="v1",
        )

        # Vector store should not be called
        assert vec_store.call_count == 0
        # BM25 results used directly
        assert len(results) == 1
        assert results[0].retrieval_id == "r2"


# ---------------------------------------------------------------------------
# Tests for determinism (Req 8.8)
# ---------------------------------------------------------------------------


class TestDeterminism:
    def test_same_inputs_produce_same_output(
        self, default_intent: QueryIntent, query_embedding: list[float]
    ) -> None:
        """Same inputs produce identical ordering (no randomness)."""
        vec_results = [
            _make_result("r1", score=0.9),
            _make_result("r2", score=0.7),
            _make_result("r3", score=0.5),
        ]
        bm25_results = [
            _make_result("r2", score=0.8),
            _make_result("r4", score=0.6),
        ]

        # Run search multiple times
        outputs = []
        for _ in range(5):
            vec_store = FakeVectorStore(results=vec_results)
            bm25_store = FakeBM25Store(results=bm25_results)
            engine = HybridSearchEngine(vec_store, bm25_store)

            results = engine.search(
                query="test",
                query_intent=default_intent,
                query_embedding=query_embedding,
                embedding_version="v1",
            )
            outputs.append([r.retrieval_id for r in results])

        # All outputs should be identical
        for output in outputs[1:]:
            assert output == outputs[0]
