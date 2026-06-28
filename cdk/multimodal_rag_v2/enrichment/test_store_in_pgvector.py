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
