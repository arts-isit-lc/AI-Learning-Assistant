"""Tests for the ingestion on-failure destination handler."""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "ca-central-1")

from . import failure_handler  # noqa: E402


class _Ctx:
    function_name = "ragIngestionFailureFunction"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:0:function:ragIngestionFailureFunction"
    memory_limit_in_mb = 256
    aws_request_id = "failure-req-1"


def _failure_record(*keys: str, error_type: str = "Runtime.OutOfMemory") -> dict[str, Any]:
    """The invocation record Lambda sends to an async on-failure destination."""
    return {
        "version": "1.0",
        "timestamp": "2026-11-24T20:53:50.781Z",
        "requestContext": {
            "requestId": "d42e27b9-efe6-4106-b757-77d7087efab5",
            "functionArn": "arn:aws:lambda:ca-central-1:0:function:ragIngestionFunction:$LATEST",
            "condition": "RetriesExhausted",
            "approximateInvokeCount": 3,
        },
        "requestPayload": {
            "Records": [
                {"s3": {"bucket": {"name": "ir-bucket"}, "object": {"key": key, "size": 140804965}}}
                for key in keys
            ]
        },
        "responseContext": {"statusCode": 200, "executedVersion": "$LATEST", "functionError": "Unhandled"},
        "responsePayload": {"errorType": error_type, "errorMessage": "Runtime exited with error: signal: killed"},
    }


@pytest.fixture
def status(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    mock = MagicMock()
    monkeypatch.setattr(failure_handler, "set_processing_status", mock)
    return mock


def test_marks_the_file_failed(status: MagicMock) -> None:
    event = _failure_record("courses/c1/m1/59df474a-7c4f-4bd8-86ae-6f3861c4a7d8.pdf")

    result = failure_handler.handler(event, _Ctx())

    status.assert_called_once_with("59df474a-7c4f-4bd8-86ae-6f3861c4a7d8", "failed")
    assert result == {"marked_failed": ["59df474a-7c4f-4bd8-86ae-6f3861c4a7d8"]}


def test_url_encoded_key_is_decoded(status: MagicMock) -> None:
    failure_handler.handler(_failure_record("courses/c1/m1/my+file%20v2.pdf"), _Ctx())

    status.assert_called_once_with("my file v2", "failed")


def test_every_record_is_marked(status: MagicMock) -> None:
    failure_handler.handler(_failure_record("courses/c/m/a.pdf", "courses/c/m/b.docx"), _Ctx())

    assert [c.args for c in status.call_args_list] == [("a", "failed"), ("b", "failed")]


def test_timeout_record_without_response_payload(status: MagicMock) -> None:
    event = _failure_record("courses/c/m/a.pdf")
    event["responsePayload"] = None

    failure_handler.handler(event, _Ctx())

    status.assert_called_once_with("a", "failed")


def test_unexpected_key_is_skipped(status: MagicMock) -> None:
    result = failure_handler.handler(_failure_record("uploads/a.pdf"), _Ctx())

    status.assert_not_called()
    assert result == {"marked_failed": []}


def test_record_without_s3_records(status: MagicMock) -> None:
    result = failure_handler.handler({"requestContext": {"condition": "EventAgeExceeded"}}, _Ctx())

    status.assert_not_called()
    assert result == {"marked_failed": []}


def test_warmup_returns_before_any_status_write(status: MagicMock) -> None:
    assert failure_handler.handler({"warmup": True}, _Ctx()) == {"warmup": True}
    status.assert_not_called()
