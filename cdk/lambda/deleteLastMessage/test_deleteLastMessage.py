"""Tests for the deleteLastMessage ownership guard (H2 IDOR fix).

psycopg2 is not installed locally (as with the other Lambda tests), so a fake is
injected into sys.modules before import; env vars + region are set so the module
imports cleanly. verify_session_ownership is a pure function over a DB cursor,
so it is exercised directly with a recording mock cursor.

Run explicitly (not part of the multimodal_rag_v2/chatbot_v2 pytest scopes):
    cd cdk && python3 -m pytest lambda/deleteLastMessage/ -v
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

# Import-time requirements: the module imports psycopg2 and constructs boto3
# clients at module load, and reads a couple of env vars.
os.environ.setdefault("SM_DB_CREDENTIALS", "secret")
os.environ.setdefault("RDS_PROXY_ENDPOINT", "proxy.local")
os.environ.setdefault("AWS_DEFAULT_REGION", "ca-central-1")
sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: MagicMock()))
sys.path.insert(0, os.path.dirname(__file__))

import deleteLastMessage as m  # noqa: E402


class _Cursor:
    def __init__(self, row):
        self._row = row
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._row

    def close(self):
        pass


def test_owner_passes():
    cur = _Cursor((1,))
    assert m.verify_session_ownership(cur, "sess-1", "owner@b.com") is True


def test_non_owner_denied():
    # No matching row -> the caller does not own the session.
    cur = _Cursor(None)
    assert m.verify_session_ownership(cur, "sess-1", "attacker@b.com") is False


def test_query_scoped_by_session_and_email():
    cur = _Cursor(None)
    m.verify_session_ownership(cur, "sess-1", "owner@b.com")
    sql, params = cur.executed[0]
    assert params == ("sess-1", "owner@b.com")
    # Full ownership chain is joined (not a bare Messages lookup).
    assert '"Sessions"' in sql
    assert '"Student_Modules"' in sql
    assert '"Enrolments"' in sql
    assert '"Users"' in sql
