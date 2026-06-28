"""Tests for the enrichment deleting-status guard (eager-module-creation Req 5.9/5.10).

The guard must skip processing (and discard the event without error) when the
module is in 'deleting' status or no longer exists, and must proceed otherwise.
The DB is mocked: a fake psycopg2 is injected into sys.modules (the real driver
isn't installed locally and the function imports it lazily) and boto3 is patched
so the Secrets Manager lookup returns a fake credential.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from . import handler as handler_module


class _FakeCursor:
    def __init__(self, fetchone_result):
        self._fetchone_result = fetchone_result

    def execute(self, sql, params=None):
        pass

    def fetchone(self):
        return self._fetchone_result

    def close(self):
        pass


class _FakeConn:
    def __init__(self, fetchone_result):
        self._fetchone_result = fetchone_result

    def cursor(self):
        return _FakeCursor(self._fetchone_result)

    def close(self):
        pass


def _configure_db(monkeypatch: pytest.MonkeyPatch, *, fetchone_result, connect_raises=False):
    if connect_raises:
        def _connect(**kwargs):
            raise RuntimeError("connection refused")
    else:
        def _connect(**kwargs):
            return _FakeConn(fetchone_result)

    monkeypatch.setitem(sys.modules, "psycopg2", SimpleNamespace(connect=_connect))

    fake_secrets = MagicMock()
    fake_secrets.get_secret_value.return_value = {
        "SecretString": '{"dbname":"aila","username":"u","password":"p","port":5432}'
    }
    monkeypatch.setattr(
        handler_module, "boto3", SimpleNamespace(client=lambda *a, **k: fake_secrets)
    )
    monkeypatch.setenv("DB_PROXY_ENDPOINT", "proxy.local")
    monkeypatch.setenv("DB_SECRET_ARN", "arn:aws:secretsmanager:::secret:db")


class TestModuleIsDeletingOrMissing:
    def test_status_deleting_returns_true(self, monkeypatch):
        _configure_db(monkeypatch, fetchone_result=("deleting",))
        assert handler_module._module_is_deleting_or_missing("m1") is True

    def test_status_active_returns_false(self, monkeypatch):
        _configure_db(monkeypatch, fetchone_result=("active",))
        assert handler_module._module_is_deleting_or_missing("m1") is False

    def test_status_draft_returns_false(self, monkeypatch):
        _configure_db(monkeypatch, fetchone_result=("draft",))
        assert handler_module._module_is_deleting_or_missing("m1") is False

    def test_module_not_found_returns_true(self, monkeypatch):
        # Req 5.9: module record missing -> discard without error.
        _configure_db(monkeypatch, fetchone_result=None)
        assert handler_module._module_is_deleting_or_missing("m1") is True

    def test_db_not_configured_returns_false(self, monkeypatch):
        # No DB env vars -> cannot check -> proceed (fail open).
        monkeypatch.delenv("DB_PROXY_ENDPOINT", raising=False)
        monkeypatch.delenv("DB_SECRET_ARN", raising=False)
        assert handler_module._module_is_deleting_or_missing("m1") is False

    def test_db_error_returns_false(self, monkeypatch):
        # Transient DB failure must not silently drop legitimate work.
        _configure_db(monkeypatch, fetchone_result=None, connect_raises=True)
        assert handler_module._module_is_deleting_or_missing("m1") is False


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
