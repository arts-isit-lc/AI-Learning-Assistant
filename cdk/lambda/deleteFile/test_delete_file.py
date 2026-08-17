"""Tests for deleteFile — deletes the correct UUID-keyed S3 object and the file's
retrieval_units, resolving the canonical file_id from Module_Files first.

Pre-V2 this built a stale key ({course}/{module}/documents/{filename}.{ext}) and
never removed retrieval_units, so the real object and its vectors were orphaned.
This verifies the V2 key (courses/{course}/{module}/{file_id}.{ext}) and the
retrieval_units cleanup, plus the idempotent no-row path.

psycopg2 isn't installed locally, so it's faked before import; connect_to_db and
the s3 client are monkeypatched.
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(__file__))
sys.modules.setdefault("psycopg2", MagicMock())
os.environ.setdefault("BUCKET", "test-bucket")
os.environ.setdefault("SM_DB_CREDENTIALS", "db-secret")
os.environ.setdefault("RDS_PROXY_ENDPOINT", "proxy.local")

import deleteFile as df  # noqa: E402

_UUID = "f98c4c90-c43e-41ca-b5ff-a28202b502f8"

_CTX = SimpleNamespace(
    function_name="deleteFile",
    function_version="$LATEST",
    invoked_function_arn="arn:aws:lambda:ca-central-1:123456789012:function:deleteFile",
    memory_limit_in_mb=128,
    aws_request_id="req-1",
)


class _FakeCursor:
    def __init__(self, recorder, fetchone_result):
        self._recorder = recorder
        self._fetchone_result = fetchone_result
        self.rowcount = 3

    def execute(self, sql, params=None):
        self._recorder.append((sql, params))

    def fetchone(self):
        return self._fetchone_result

    def close(self):
        pass


class _FakeConn:
    def __init__(self, recorder, fetchone_result):
        self._recorder = recorder
        self._fetchone_result = fetchone_result

    def cursor(self):
        return _FakeCursor(self._recorder, self._fetchone_result)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


def _invoke(file_name="Algorithms_in_Production-v5", file_type="pdf"):
    event = {
        "queryStringParameters": {
            "course_id": "c1",
            "module_id": "m1",
            "file_name": file_name,
            "file_type": file_type,
        }
    }
    return df.lambda_handler(event, _CTX)


def test_deletes_stored_filepath_object_and_retrieval_units(monkeypatch):
    recorder: list[tuple] = []
    # The stored filepath diverges from the reconstructed courses/c1/m1/{uuid}.pdf
    # key — the delete must follow the authoritative stored key, otherwise the S3
    # object is orphaned and get_all_files re-surfaces it under its raw UUID name.
    stored_filepath = f"courses/c1/m1/{_UUID}.PDF"
    monkeypatch.setattr(df, "connect_to_db", lambda: _FakeConn(recorder, (_UUID, stored_filepath)))
    fake_s3 = MagicMock()
    monkeypatch.setattr(df, "s3", fake_s3)

    resp = _invoke()
    assert resp["statusCode"] == 200

    # S3 delete addresses the exact stored key — not a reconstructed one.
    _, kwargs = fake_s3.delete_objects.call_args
    keys = [o["Key"] for o in kwargs["Delete"]["Objects"]]
    assert keys == [stored_filepath]
    assert all("/documents/" not in k for k in keys)

    # retrieval_units + Module_Files are both deleted by the UUID file_id.
    ru = [(s, p) for s, p in recorder if "retrieval_units" in s]
    mf = [(s, p) for s, p in recorder if 'DELETE FROM "Module_Files"' in s]
    assert ru and ru[0][1] == (_UUID,)
    assert mf and mf[0][1] == (_UUID,)


def test_falls_back_to_reconstructed_key_when_filepath_missing(monkeypatch):
    # Legacy rows have no persisted filepath — reconstruct the canonical V2 key.
    recorder: list[tuple] = []
    monkeypatch.setattr(df, "connect_to_db", lambda: _FakeConn(recorder, (_UUID, None)))
    fake_s3 = MagicMock()
    monkeypatch.setattr(df, "s3", fake_s3)

    resp = _invoke()
    assert resp["statusCode"] == 200

    _, kwargs = fake_s3.delete_objects.call_args
    keys = [o["Key"] for o in kwargs["Delete"]["Objects"]]
    assert keys == [f"courses/c1/m1/{_UUID}.pdf"]
    assert all("/documents/" not in k for k in keys)


def test_no_matching_row_skips_s3_delete_and_succeeds(monkeypatch):
    recorder: list[tuple] = []
    monkeypatch.setattr(df, "connect_to_db", lambda: _FakeConn(recorder, None))  # SELECT finds nothing
    fake_s3 = MagicMock()
    monkeypatch.setattr(df, "s3", fake_s3)

    resp = _invoke(file_name="does-not-exist")

    assert resp["statusCode"] == 200  # idempotent
    fake_s3.delete_objects.assert_not_called()
