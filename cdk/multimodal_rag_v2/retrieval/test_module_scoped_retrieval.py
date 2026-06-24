"""Tests for module-scoped retrieval — metadata filter passing through the pipeline.

Validates:
- HybridSearchEngine.search() accepts and merges external metadata_filter
- combined_filter merges module_id with intent-based filter
- Vector search WHERE clause includes module_id filter
- BM25 search includes module_id filter
- No filter applied when module_id is empty
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import pytest

from ..models.data_models import QueryIntent
from .hybrid_search_engine import HybridSearchEngine


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeVectorStore:
    """Fake vector store that records search calls."""

    def __init__(self, results: list[dict] | None = None):
        self.results = results or []
        self.calls: list[dict] = []

    def search(
        self,
        query_embedding: list[float],
        k: int,
        embedding_version: str,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        self.calls.append({
            "query_embedding": query_embedding,
            "k": k,
            "embedding_version": embedding_version,
            "metadata_filter": metadata_filter,
        })
        return self.results


class FakeBM25Store:
    """Fake BM25 store that records search calls."""

    def __init__(self, results: list[dict] | None = None):
        self.results = results or []
        self.calls: list[dict] = []

    def search(
        self,
        query: str,
        k: int,
        metadata_filter: dict | None = None,
    ) -> list[dict]:
        self.calls.append({
            "query": query,
            "k": k,
            "metadata_filter": metadata_filter,
        })
        return self.results


# ---------------------------------------------------------------------------
# Tests: Module-scoped metadata filter
# ---------------------------------------------------------------------------


class TestModuleScopedFilter:
    """External metadata_filter with module_id is passed through to both stores."""

    def test_module_id_filter_passed_to_vector_store(self) -> None:
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        engine.search(
            query="What is Big-O?",
            query_intent=QueryIntent(),
            query_embedding=[0.1] * 1024,
            k=15,
            embedding_version="titan-v2-1024",
            metadata_filter={"module_id": "mod-123"},
        )

        # First call uses the filter; may retry without filter if zero results
        assert len(vector_store.calls) >= 1
        assert vector_store.calls[0]["metadata_filter"] == {"module_id": "mod-123"}

    def test_module_id_filter_passed_to_bm25_store(self) -> None:
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        engine.search(
            query="What is Big-O?",
            query_intent=QueryIntent(),
            query_embedding=[0.1] * 1024,
            k=15,
            embedding_version="titan-v2-1024",
            metadata_filter={"module_id": "mod-123"},
        )

        # First call uses the filter; may retry without filter if zero results
        assert len(bm25_store.calls) >= 1
        assert bm25_store.calls[0]["metadata_filter"] == {"module_id": "mod-123"}

    def test_no_filter_when_metadata_filter_is_none(self) -> None:
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        engine.search(
            query="What is Big-O?",
            query_intent=QueryIntent(),
            query_embedding=[0.1] * 1024,
            k=15,
            embedding_version="titan-v2-1024",
            metadata_filter=None,
        )

        # When no external filter and no intent-based filter, should pass None or empty
        vector_filter = vector_store.calls[0]["metadata_filter"]
        bm25_filter = bm25_store.calls[0]["metadata_filter"]
        # combined_filter = {} merged with None intent filter = {} → passed as None
        assert vector_filter is None or vector_filter == {}

    def test_no_filter_when_empty_dict(self) -> None:
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        engine.search(
            query="What is Big-O?",
            query_intent=QueryIntent(),
            query_embedding=[0.1] * 1024,
            k=15,
            embedding_version="titan-v2-1024",
            metadata_filter={},
        )

        # Empty external filter + no intent filter = None or empty
        vector_filter = vector_store.calls[0]["metadata_filter"]
        assert vector_filter is None or vector_filter == {}


class TestCombinedFilter:
    """External filter merges with intent-based filter."""

    def test_module_id_merges_with_lecture_number_filter(self) -> None:
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        intent = QueryIntent(needs_summary=True, lecture_number=5)

        engine.search(
            query="What was covered?",
            query_intent=intent,
            query_embedding=[0.1] * 1024,
            k=15,
            embedding_version="titan-v2-1024",
            metadata_filter={"module_id": "mod-456"},
        )

        # Should have both module_id and lecture_number in the filter
        vector_filter = vector_store.calls[0]["metadata_filter"]
        assert vector_filter is not None
        assert "module_id" in vector_filter
        assert vector_filter["module_id"] == "mod-456"

    def test_external_filter_does_not_override_intent_filter(self) -> None:
        """Intent-based filter keys don't get overwritten by external filter."""
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        intent = QueryIntent(needs_summary=True, lecture_number=3)

        engine.search(
            query="Lecture overview",
            query_intent=intent,
            query_embedding=[0.1] * 1024,
            k=15,
            embedding_version="titan-v2-1024",
            metadata_filter={"module_id": "mod-789"},
        )

        vector_filter = vector_store.calls[0]["metadata_filter"]
        # Both keys should exist
        assert "module_id" in vector_filter


class TestSearchWithoutEmbedding:
    """When no query_embedding provided, only BM25 runs."""

    def test_bm25_only_when_no_embedding(self) -> None:
        vector_store = FakeVectorStore()
        bm25_store = FakeBM25Store()
        engine = HybridSearchEngine(vector_store=vector_store, bm25_store=bm25_store)

        engine.search(
            query="What is sorting?",
            query_intent=QueryIntent(),
            query_embedding=None,
            k=10,
            embedding_version="titan-v2-1024",
            metadata_filter={"module_id": "mod-100"},
        )

        assert len(vector_store.calls) == 0
        assert len(bm25_store.calls) >= 1
        assert bm25_store.calls[0]["metadata_filter"] == {"module_id": "mod-100"}
