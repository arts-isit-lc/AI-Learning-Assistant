"""Tests for deleteModule — deletes a module's S3 objects under the V2
`courses/{course_id}/{module_id}/` prefix in the irBucket.

Pre-V2 this listed the bare `{course_id}/{module_id}/` prefix (and the CDK wired
it to the wrong bucket), so deleting a module removed nothing from S3. These
tests pin the V2 prefix and the list→delete flow.
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("BUCKET", "test-ir-bucket")

import deleteModule as dm  # noqa: E402

_CTX = SimpleNamespace(
    function_name="deleteModule",
    function_version="$LATEST",
    invoked_function_arn="arn:aws:lambda:ca-central-1:123456789012:function:deleteModule",
    memory_limit_in_mb=128,
    aws_request_id="req-1",
)


def _invoke(course_id="c1", module_id="m1"):
    event = {"queryStringParameters": {"course_id": course_id, "module_id": module_id}}
    return dm.lambda_handler(event, _CTX)


def test_lists_and_deletes_under_courses_prefix(monkeypatch):
    fake_s3 = MagicMock()
    fake_s3.list_objects_v2.return_value = {
        "Contents": [
            {"Key": "courses/c1/m1/uuid1.pdf"},
            {"Key": "courses/c1/m1/uuid1/ir.json"},
        ],
        "IsTruncated": False,
    }
    monkeypatch.setattr(dm, "s3", fake_s3)

    resp = _invoke()
    assert resp["statusCode"] == 200

    # Listing uses the V2 courses/ prefix on the (ir)bucket — not the bare
    # {course}/{module}/ prefix.
    _, list_kwargs = fake_s3.list_objects_v2.call_args
    assert list_kwargs["Prefix"] == "courses/c1/m1/"
    assert list_kwargs["Bucket"] == "test-ir-bucket"

    # Every listed object is deleted.
    _, del_kwargs = fake_s3.delete_objects.call_args
    keys = [o["Key"] for o in del_kwargs["Delete"]["Objects"]]
    assert keys == ["courses/c1/m1/uuid1.pdf", "courses/c1/m1/uuid1/ir.json"]


def test_no_objects_found_is_idempotent(monkeypatch):
    fake_s3 = MagicMock()
    fake_s3.list_objects_v2.return_value = {"IsTruncated": False}  # no Contents
    monkeypatch.setattr(dm, "s3", fake_s3)

    resp = _invoke()
    assert resp["statusCode"] == 200
    fake_s3.delete_objects.assert_not_called()


def test_missing_params_returns_400(monkeypatch):
    fake_s3 = MagicMock()
    monkeypatch.setattr(dm, "s3", fake_s3)

    resp = _invoke(course_id="", module_id="")
    assert resp["statusCode"] == 400
    fake_s3.list_objects_v2.assert_not_called()
