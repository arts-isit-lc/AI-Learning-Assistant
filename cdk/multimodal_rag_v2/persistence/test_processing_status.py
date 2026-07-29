"""Tests for the shared best-effort processing_status writer.

The DB is mocked: a fake psycopg2 is injected into sys.modules (the real driver
isn't installed locally and the module imports it lazily) and boto3 is patched
so the Secrets Manager lookup returns a fake credential.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

from . import processing_status as ps

_UUID = "f98c4c90-c43e-41ca-b5ff-a28202b502f8"


class _FakeCursor:
    def __init__(self, recorder: list[tuple], *, rowcount: int = 1):
        self._recorder = recorder
        self.rowcount = rowcount

    def execute(self, sql, params=None):
        self._recorder.append((sql, params))

    def close(self):
        pass


class _FakeConn:
    def __init__(self, recorder: list[tuple], *, rowcount: int = 1):
        self._recorder = recorder
        self._rowcount = rowcount

    def cursor(self):
        return _FakeCursor(self._recorder, rowcount=self._rowcount)

    def commit(self):
        pass

    def close(self):
        pass


def _fake_secrets_client():
    fake = MagicMock()
    fake.get_secret_value.return_value = {
        "SecretString": '{"dbname":"aila","username":"u","password":"p","port":5432}'
    }
    return fake


def _patch_db(monkeypatch, recorder, *, rowcount: int = 1, connect_raises: bool = False):
    if connect_raises:
        def _connect(**kwargs):
            raise RuntimeError("connection refused")
    else:
        def _connect(**kwargs):
            return _FakeConn(recorder, rowcount=rowcount)

    monkeypatch.setitem(sys.modules, "psycopg2", SimpleNamespace(connect=_connect))
    monkeypatch.setattr(ps, "boto3", SimpleNamespace(client=lambda *a, **k: _fake_secrets_client()))
    monkeypatch.setenv("DB_PROXY_ENDPOINT", "proxy.local")
    monkeypatch.setenv("DB_SECRET_ARN", "arn:aws:secretsmanager:::secret:db")


def test_updates_processing_status_by_file_id_uuid(monkeypatch):
    recorder: list[tuple] = []
    _patch_db(monkeypatch, recorder, rowcount=1)

    ps.set_processing_status(_UUID, "enriching")

    updates = [(s, p) for s, p in recorder if "UPDATE" in s and "Module_Files" in s]
    assert len(updates) == 1, "expected exactly one Module_Files UPDATE"
    sql, params = updates[0]
    assert "processing_status = %s" in sql
    assert "WHERE file_id = %s" in sql
    assert "filename" not in sql, "must match on the canonical file_id UUID"
    assert params == ("enriching", _UUID)


def test_no_op_when_db_not_configured(monkeypatch):
    # No env vars -> must return before attempting any DB connection.
    monkeypatch.setitem(
        sys.modules,
        "psycopg2",
        SimpleNamespace(connect=lambda **k: (_ for _ in ()).throw(AssertionError("must not connect"))),
    )
    monkeypatch.delenv("DB_PROXY_ENDPOINT", raising=False)
    monkeypatch.delenv("DB_SECRET_ARN", raising=False)

    # Should not raise and should not connect.
    ps.set_processing_status(_UUID, "ingesting")


def test_swallows_db_errors(monkeypatch):
    recorder: list[tuple] = []
    _patch_db(monkeypatch, recorder, connect_raises=True)

    # Best-effort: a connection failure must never propagate.
    ps.set_processing_status(_UUID, "ingesting")
