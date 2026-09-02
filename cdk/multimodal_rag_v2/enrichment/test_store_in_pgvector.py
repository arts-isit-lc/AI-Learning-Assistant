"""Tests for enrichment _store_in_pgvector — verifies file_id/module_id are
written as first-class columns (cross-module-file-referencing spec, T4).

The DB is mocked: a fake psycopg2 is injected into sys.modules (the real driver
isn't installed locally and the function imports psycopg2 lazily) and boto3 is
patched so the Secrets Manager lookup returns a fake credential.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ..models.data_models import ElementType, Provenance, RetrievalUnit
from . import handler as handler_module


class _FakeCursor:
    def __init__(self, recorder: list[tuple]):
        self._recorder = recorder

    def execute(self, sql, params=None):
        self._recorder.append((sql, params))

    def close(self):
        pass


class _FakeConn:
    def __init__(self, recorder: list[tuple]):
        self._recorder = recorder

    def cursor(self):
        return _FakeCursor(self._recorder)

    def commit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def captured_sql(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    recorder: list[tuple] = []

    # Fake psycopg2 (lazy `import psycopg2` inside the function resolves this).
    fake_psycopg2 = SimpleNamespace(connect=lambda **kwargs: _FakeConn(recorder))
    monkeypatch.setitem(sys.modules, "psycopg2", fake_psycopg2)

    # Fake Secrets Manager via boto3.client used inside the function.
    fake_secrets = MagicMock()
    fake_secrets.get_secret_value.return_value = {
        "SecretString": '{"dbname":"aila","username":"u","password":"p","port":5432}'
    }
    monkeypatch.setattr(handler_module, "boto3", SimpleNamespace(client=lambda *a, **k: fake_secrets))

    monkeypatch.setenv("DB_PROXY_ENDPOINT", "proxy.local")
    monkeypatch.setenv("DB_SECRET_ARN", "arn:aws:secretsmanager:::secret:db")
    return recorder


def _unit_with_embedding() -> RetrievalUnit:
    return RetrievalUnit(
        retrieval_id="ret-1",
        parent_element_id="el-1",
        embedding_text="Big-O complexity of mergesort",
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=1, position_index=0),
        metadata={"embedding": [0.1, 0.2, 0.3], "content_type": "text"},
        sibling_ids=[],
        embedding_version="titan-v2-1024",
    )


def test_insert_includes_file_id_and_module_id_columns(captured_sql) -> None:
    handler_module._store_in_pgvector(
        [_unit_with_embedding()],
        course_id="course-1",
        module_id="module-9",
        file_id="3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    )

    inserts = [(sql, params) for sql, params in captured_sql if "INSERT INTO retrieval_units" in sql]
    assert len(inserts) == 1, "expected exactly one INSERT"
    sql, params = inserts[0]

    # Columns present in the statement
    assert "file_id" in sql and "module_id" in sql
    # Canonical UUID file_id and module_id passed as bound params (not just metadata)
    assert "3f2504e0-4f89-41d3-9a0c-0305e82c3301" in params
    assert "module-9" in params


def test_metadata_still_carries_file_id_for_backward_compat(captured_sql) -> None:
    # figure_url and other readers still resolve via metadata, so file_id/course_id/
    # module_id must remain inside the stored metadata JSON too.
    import json

    handler_module._store_in_pgvector(
        [_unit_with_embedding()],
        course_id="course-1",
        module_id="module-9",
        file_id="uuid-abc",
    )

    sql, params = next(
        (s, p) for s, p in captured_sql if "INSERT INTO retrieval_units" in s
    )
    metadata_json = next(p for p in params if isinstance(p, str) and p.startswith("{"))
    meta = json.loads(metadata_json)
    assert meta["file_id"] == "uuid-abc"
    assert meta["module_id"] == "module-9"
    assert meta["course_id"] == "course-1"


def test_delete_targets_first_class_file_id_column(captured_sql) -> None:
    # M9: incremental re-ingestion must DELETE by the indexed file_id column,
    # not the unindexed metadata->>'file_id' JSON path (which diverged from
    # deleteFile + retrieval scoping and idx_retrieval_units_file_id).
    handler_module._store_in_pgvector(
        [_unit_with_embedding()],
        course_id="course-1",
        module_id="module-9",
        file_id="uuid-del",
    )

    deletes = [
        (sql, params) for sql, params in captured_sql
        if sql.strip().upper().startswith("DELETE")
    ]
    assert len(deletes) == 1, "expected exactly one DELETE"
    sql, params = deletes[0]
    assert "file_id = %s" in sql
    assert "metadata->>'file_id'" not in sql
    assert params == ("uuid-del",)


def _unit_with_nul_bytes() -> RetrievalUnit:
    # PDF extraction can leak NUL (0x00) bytes into text; they appear in both
    # embedding_text and enriched metadata values.
    return RetrievalUnit(
        retrieval_id="ret-nul",
        parent_element_id="el-1",
        embedding_text="Mergesort\x00 runs in O(n log n)\x00",
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=1, position_index=0),
        metadata={
            "embedding": [0.1, 0.2, 0.3],
            "content_type": "text",
            "description": "A chart\x00 of scores",
            "labels": ["clean", "dir\x00ty"],
        },
        sibling_ids=[],
        embedding_version="titan-v2-1024",
    )


def test_nul_bytes_stripped_from_text_and_metadata_before_insert(captured_sql) -> None:
    # Regression: a raw NUL (0x00) in extracted text made psycopg2 raise
    # "A string literal cannot contain NUL (0x00) characters", failing the whole
    # pgvector write and leaving the file stuck at 'enriching'. NULs must be
    # scrubbed from every text param (embedding_text, the to_tsvector text, and
    # the jsonb metadata) so the write succeeds.
    import json

    handler_module._store_in_pgvector(
        [_unit_with_nul_bytes()],
        course_id="course-1",
        module_id="module-9",
        file_id="uuid-nul",
    )

    sql, params = next(
        (s, p) for s, p in captured_sql if "INSERT INTO retrieval_units" in s
    )

    # No bound string param may contain a raw NUL.
    for p in params:
        if isinstance(p, str):
            assert "\x00" not in p, f"NUL leaked into param: {p!r}"

    # embedding_text is passed twice (column value + to_tsvector); both cleaned.
    text_params = [p for p in params if isinstance(p, str) and "Mergesort" in p]
    assert len(text_params) == 2
    assert all(t == "Mergesort runs in O(n log n)" for t in text_params)

    # jsonb metadata (including nested list values) is scrubbed too.
    metadata_json = next(p for p in params if isinstance(p, str) and p.startswith("{"))
    assert "\\u0000" not in metadata_json and "\x00" not in metadata_json
    meta = json.loads(metadata_json)
    assert meta["description"] == "A chart of scores"
    assert meta["labels"] == ["clean", "dirty"]


def _unit_without_embedding() -> RetrievalUnit:
    return RetrievalUnit(
        retrieval_id="ret-no-embed",
        parent_element_id="el-1",
        embedding_text="Big-O complexity of mergesort",
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=1, position_index=0),
        metadata={"content_type": "text"},  # NO 'embedding' key
        sibling_ids=[],
        embedding_version="titan-v2-1024",
    )


def test_zero_embeddable_units_raises_before_any_delete(captured_sql) -> None:
    # H5: a store call with no embeddable units must NOT DELETE+commit an empty
    # index (which would wipe the file's existing vectors). It must raise before
    # issuing any SQL so the SQS record is retried.
    with pytest.raises(RuntimeError):
        handler_module._store_in_pgvector(
            [_unit_without_embedding()],
            course_id="course-1",
            module_id="module-9",
            file_id="uuid-empty",
        )

    # No SQL at all — the guard fires before the DB connection is opened.
    assert captured_sql == []
