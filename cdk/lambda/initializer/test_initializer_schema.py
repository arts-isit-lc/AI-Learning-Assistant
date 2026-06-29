"""Schema-migration guard tests for the DB initializer (Phase 1 #2).

The initializer's DDL lives as an inline SQL string inside the handler, so this
verifies it at the source level: the ANN (HNSW) index must be present, use the
opclass that matches the retrieval query's distance operator, and degrade
gracefully on older pgvector. Deterministic — no DB or import required.
"""
from __future__ import annotations

import os

_INIT_PATH = os.path.join(os.path.dirname(__file__), "initializer.py")


def _source() -> str:
    with open(_INIT_PATH, encoding="utf-8") as f:
        return f.read()


class TestHnswIndex:
    def test_hnsw_index_present_on_embedding(self):
        src = _source()
        assert "USING hnsw (embedding vector_cosine_ops)" in src, (
            "HNSW ANN index on retrieval_units.embedding is missing"
        )

    def test_index_name_and_table(self):
        src = _source()
        assert "idx_retrieval_units_embedding_hnsw" in src
        assert "ON retrieval_units" in src

    def test_uses_cosine_opclass_matching_query_operator(self):
        # The retrieval query orders by `embedding <=> %s::vector` (cosine
        # distance), so the index opclass must be vector_cosine_ops.
        assert "vector_cosine_ops" in _source()

    def test_wrapped_for_graceful_degradation(self):
        # Must not abort schema init if pgvector lacks HNSW support.
        src = _source()
        assert "EXCEPTION WHEN OTHERS THEN" in src
        assert "HNSW index skipped" in src

    def test_existing_indexes_preserved(self):
        src = _source()
        assert "idx_retrieval_units_ts_vector" in src
        assert "idx_retrieval_units_embedding_version" in src
