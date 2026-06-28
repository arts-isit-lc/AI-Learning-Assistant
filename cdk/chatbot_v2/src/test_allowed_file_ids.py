"""Tests for chatbot_v2 _get_allowed_file_ids (cross-module-file-referencing T7).

main.py imports psycopg2 at module load and isn't installed locally, so a bare
fake is injected into sys.modules before importing main. The DB connection is
then monkeypatched per-test.
"""

import os
import sys
from types import SimpleNamespace

import pytest

# Fake psycopg2 so `import psycopg2` in main.py resolves (driver not installed locally).
sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql, params=None):
        self.sql = sql
        self.params = params

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return _FakeCursor(self._rows)

    def rollback(self):
        pass


def _configure(monkeypatch, enabled=True, conn=None):
    monkeypatch.setattr(main, "ENABLE_CROSS_MODULE_REFERENCING", enabled)
    monkeypatch.setattr(main, "DB_SECRET_ARN", "arn")
    monkeypatch.setattr(main, "DB_PROXY_ENDPOINT", "proxy")
    if conn is not None:
        monkeypatch.setattr(main, "_get_db_connection", lambda: conn)


def test_returns_union_of_own_and_referenced(monkeypatch):
    _configure(monkeypatch, conn=_FakeConn([("f1",), ("f2",), ("ref-3",)]))
    assert main._get_allowed_file_ids("mod-1") == ["f1", "f2", "ref-3"]


def test_disabled_flag_returns_empty(monkeypatch):
    _configure(monkeypatch, enabled=False, conn=_FakeConn([("f1",)]))
    assert main._get_allowed_file_ids("mod-1") == []


def test_empty_module_id_returns_empty(monkeypatch):
    _configure(monkeypatch, conn=_FakeConn([("f1",)]))
    assert main._get_allowed_file_ids("") == []


def test_db_error_falls_back_to_empty(monkeypatch):
    _configure(monkeypatch)

    def boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(main, "_get_db_connection", boom)
    assert main._get_allowed_file_ids("mod-1") == []


def test_filters_out_null_ids(monkeypatch):
    _configure(monkeypatch, conn=_FakeConn([("f1",), (None,), ("f2",)]))
    assert main._get_allowed_file_ids("mod-1") == ["f1", "f2"]
