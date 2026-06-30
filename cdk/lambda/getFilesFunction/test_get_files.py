"""Tests for getFilesFunction — maps UUID-keyed S3 objects back to the human
filename + metadata via the canonical file_id.

Since the cross-module-file-referencing change, S3 objects are "{file_id}.{ext}"
(UUID). The instructor UI keys off the human filename and reads
fileData.metadata.{file_id,description,topic_extraction}. This verifies the
response is keyed by "{filename}.{filetype}" (not the UUID) and carries metadata
including file_id, with the presigned URL pointing at the real UUID object.

psycopg2 isn't installed locally, so it's faked before import; the handler's S3
and DB helpers are monkeypatched.
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
os.environ.setdefault("REGION", "ca-central-1")
os.environ.setdefault("BUCKET", "test-bucket")
os.environ.setdefault("SM_DB_CREDENTIALS", "db-secret")
os.environ.setdefault("RDS_PROXY_ENDPOINT", "proxy.local")

import getFilesFunction as gf  # noqa: E402

_UUID1 = "f98c4c90-c43e-41ca-b5ff-a28202b502f8"
_UUID2 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"

_CTX = SimpleNamespace(
    function_name="getFilesFunction",
    function_version="$LATEST",
    invoked_function_arn="arn:aws:lambda:ca-central-1:123456789012:function:getFilesFunction",
    memory_limit_in_mb=128,
    aws_request_id="req-1",
)


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows

    def execute(self, sql, params=None):
        self._sql = sql
        self._params = params

    def fetchall(self):
        return self._rows

    def close(self):
        pass


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def cursor(self):
        return _FakeCursor(self._rows)

    def close(self):
        pass


@pytest.fixture
def patched(monkeypatch):
    rows = [
        (
            _UUID1,
            "Algorithms_in_Production-v5",
            "pdf",
            {"description": "d", "topic_extraction": {"topics": ["sorting"]}},
        ),
        (_UUID2, "Lecture_Notes", "docx", {}),
    ]
    monkeypatch.setattr(gf, "connect_to_db", lambda: _FakeConn(rows))
    monkeypatch.setattr(
        gf, "list_files_in_s3_prefix", lambda bucket, prefix: [f"{_UUID1}.pdf", f"{_UUID2}.docx"]
    )
    monkeypatch.setattr(gf, "generate_presigned_url", lambda bucket, key: f"https://signed/{key}")


def _invoke(course_id="c1", module_id="m1"):
    event = {"queryStringParameters": {"course_id": course_id, "module_id": module_id}}
    resp = gf.lambda_handler(event, _CTX)
    assert resp["statusCode"] == 200
    return json.loads(resp["body"])["document_files"]


def test_response_keyed_by_human_filename_not_uuid(patched):
    files = _invoke()
    assert "Algorithms_in_Production-v5.pdf" in files
    assert "Lecture_Notes.docx" in files
    # The raw UUID object name must NOT be the displayed key.
    assert f"{_UUID1}.pdf" not in files


def test_presigned_url_targets_the_uuid_object(patched):
    files = _invoke()
    assert (
        files["Algorithms_in_Production-v5.pdf"]["url"]
        == f"https://signed/courses/c1/m1/{_UUID1}.pdf"
    )


def test_metadata_carries_file_id_and_topics(patched):
    files = _invoke()
    meta = files["Algorithms_in_Production-v5.pdf"]["metadata"]
    assert meta["file_id"] == _UUID1
    assert meta["topic_extraction"]["topics"] == ["sorting"]


def test_orphan_s3_object_without_db_row_falls_back_to_raw_key(monkeypatch, patched):
    # An S3 object whose stem has no Module_Files row is surfaced by its raw key
    # with null metadata rather than being dropped.
    monkeypatch.setattr(gf, "list_files_in_s3_prefix", lambda bucket, prefix: ["orphan-uuid.pdf"])
    files = _invoke()
    assert files["orphan-uuid.pdf"]["metadata"] is None
