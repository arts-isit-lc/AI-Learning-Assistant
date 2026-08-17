"""Tests for orphanCleanup — the S3 step must delete a module's objects under the
V2 `courses/{course_id}/{module_id}/` prefix in the irBucket.

Pre-V2 this listed the bare `{course_id}/{module_id}/` prefix on the wrong bucket
(DATA_INGESTION_BUCKET), so orphaned module objects were never removed. psycopg2
isn't installed locally, so it's faked before import; the DB connection + s3
client are supplied as fakes/monkeypatched.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))
sys.modules.setdefault("psycopg2", MagicMock())
os.environ.setdefault("SM_DB_CREDENTIALS", "db-secret")
os.environ.setdefault("RDS_PROXY_ENDPOINT", "proxy.local")
os.environ.setdefault("BUCKET", "test-ir-bucket")

import orphanCleanup as oc  # noqa: E402


class _FakeCursor:
    def __init__(self):
        self.rowcount = 0

    def execute(self, *args, **kwargs):
        pass

    def fetchone(self):
        return None  # no embeddings collection

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeConn:
    def cursor(self):
        return _FakeCursor()

    def commit(self):
        pass

    def rollback(self):
        pass


def test_cleanup_deletes_s3_under_courses_prefix(monkeypatch):
    fake_s3 = MagicMock()
    fake_s3.list_objects_v2.return_value = {
        "Contents": [{"Key": "courses/c1/m1/uuid.pdf"}],
        "IsTruncated": False,
    }
    monkeypatch.setattr(oc, "s3_client", fake_s3)

    oc.cleanup_module(_FakeConn(), "m1", "c1")

    # Listing + deletion target the V2 courses/ prefix on the irBucket.
    _, list_kwargs = fake_s3.list_objects_v2.call_args
    assert list_kwargs["Prefix"] == "courses/c1/m1/"
    assert list_kwargs["Bucket"] == "test-ir-bucket"

    _, del_kwargs = fake_s3.delete_objects.call_args
    assert del_kwargs["Bucket"] == "test-ir-bucket"
    keys = [o["Key"] for o in del_kwargs["Delete"]["Objects"]]
    assert keys == ["courses/c1/m1/uuid.pdf"]


def test_cleanup_skips_s3_delete_when_no_objects(monkeypatch):
    fake_s3 = MagicMock()
    fake_s3.list_objects_v2.return_value = {"IsTruncated": False}  # no Contents
    monkeypatch.setattr(oc, "s3_client", fake_s3)

    oc.cleanup_module(_FakeConn(), "m1", "c1")

    fake_s3.delete_objects.assert_not_called()
