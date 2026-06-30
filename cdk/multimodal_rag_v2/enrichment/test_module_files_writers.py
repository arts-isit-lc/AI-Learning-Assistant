"""Tests for the enrichment Module_Files writers — they must match the canonical
UUID file_id (Module_Files.file_id, the primary key), NOT the filename.

Before the cross-module-file-referencing change, file_id was the filename stem
so these helpers matched on the `filename` column. Once file_id became the DB
UUID (S3 key carries the UUID), `filename = '<uuid>'` matched zero rows: the UI
spinner stayed on 'pending' (processing_status never flipped to 'complete') and
topic metadata was never written. These tests lock in the UUID-PK match.

DB + Bedrock are mocked: a fake psycopg2 is injected into sys.modules (the real
driver isn't installed locally and the functions import it lazily) and boto3 is
patched so Secrets Manager / Bedrock calls return canned values.
"""
from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from . import handler as handler_module

_UUID = "f98c4c90-c43e-41ca-b5ff-a28202b502f8"


class _FakeCursor:
    def __init__(self, recorder: list[tuple], *, rowcount: int = 1, fetchone_result=None):
        self._recorder = recorder
        self.rowcount = rowcount
        self._fetchone_result = fetchone_result

    def execute(self, sql, params=None):
        self._recorder.append((sql, params))

    def fetchone(self):
        return self._fetchone_result

    def close(self):
        pass


class _FakeConn:
    def __init__(self, recorder: list[tuple], *, rowcount: int = 1, fetchone_result=None):
        self._recorder = recorder
        self._rowcount = rowcount
        self._fetchone_result = fetchone_result

    def cursor(self):
        return _FakeCursor(self._recorder, rowcount=self._rowcount, fetchone_result=self._fetchone_result)

    def commit(self):
        pass

    def close(self):
        pass


def _patch_db(monkeypatch, recorder, *, rowcount: int = 1, fetchone_result=None):
    fake_psycopg2 = SimpleNamespace(
        connect=lambda **kwargs: _FakeConn(recorder, rowcount=rowcount, fetchone_result=fetchone_result)
    )
    monkeypatch.setitem(sys.modules, "psycopg2", fake_psycopg2)
    monkeypatch.setenv("DB_PROXY_ENDPOINT", "proxy.local")
    monkeypatch.setenv("DB_SECRET_ARN", "arn:aws:secretsmanager:::secret:db")


def _fake_secrets_client():
    fake = MagicMock()
    fake.get_secret_value.return_value = {
        "SecretString": '{"dbname":"aila","username":"u","password":"p","port":5432}'
    }
    return fake


class TestUpdateProcessingStatus:
    def test_updates_by_file_id_uuid_not_filename(self, monkeypatch):
        recorder: list[tuple] = []
        _patch_db(monkeypatch, recorder, rowcount=1)
        monkeypatch.setattr(
            handler_module, "boto3", SimpleNamespace(client=lambda *a, **k: _fake_secrets_client())
        )

        handler_module._update_processing_status(_UUID, "module-9", 7)

        updates = [(s, p) for s, p in recorder if "UPDATE" in s and "Module_Files" in s]
        assert len(updates) == 1, "expected exactly one Module_Files UPDATE"
        sql, params = updates[0]
        assert "WHERE file_id = %s" in sql
        assert "filename" not in sql, "must not match on the filename column"
        # chunk_count + canonical UUID bound; module_id is NOT part of the match.
        assert params == (7, _UUID)

    def test_zero_rows_logs_warning_and_does_not_raise(self, monkeypatch):
        # A mismatched file_id (no row) must surface as a WARNING, not a false
        # "complete" INFO — this is exactly how the old filename match failed.
        recorder: list[tuple] = []
        _patch_db(monkeypatch, recorder, rowcount=0)
        monkeypatch.setattr(
            handler_module, "boto3", SimpleNamespace(client=lambda *a, **k: _fake_secrets_client())
        )
        fake_logger = MagicMock()
        monkeypatch.setattr(handler_module, "logger", fake_logger)

        handler_module._update_processing_status(_UUID, "module-9", 0)

        assert fake_logger.warning.called, "zero-row update should log a warning"
        assert not fake_logger.info.called, "must not log a success INFO when no row matched"


class TestExtractAndStoreTopics:
    def test_select_and_update_match_by_file_id_uuid(self, monkeypatch):
        recorder: list[tuple] = []
        _patch_db(monkeypatch, recorder, rowcount=1, fetchone_result=(None,))

        # boto3.client must return Bedrock for "bedrock-runtime" and Secrets
        # Manager otherwise.
        def fake_client(service, *a, **k):
            if service == "bedrock-runtime":
                bedrock = MagicMock()
                body = MagicMock()
                body.read.return_value = json.dumps(
                    {
                        "content": [
                            {
                                "text": json.dumps(
                                    {
                                        "topics": ["Sorting", "Big-O"],
                                        "learning_objectives": ["Analyze complexity"],
                                        "confidence": 0.9,
                                    }
                                )
                            }
                        ]
                    }
                )
                bedrock.invoke_model.return_value = {"body": body}
                return bedrock
            return _fake_secrets_client()

        monkeypatch.setattr(handler_module, "boto3", SimpleNamespace(client=fake_client))

        elem = SimpleNamespace(embedding_text="Mergesort runs in O(n log n).")
        handler_module._extract_and_store_topics([elem], _UUID, "module-9")

        mf_queries = [(s, p) for s, p in recorder if "Module_Files" in s]
        assert len(mf_queries) == 2, "expected a Module_Files SELECT and UPDATE"
        for sql, params in mf_queries:
            assert "WHERE file_id = %s" in sql
            assert "filename" not in sql, "must not match on the filename column"
            assert _UUID in params
