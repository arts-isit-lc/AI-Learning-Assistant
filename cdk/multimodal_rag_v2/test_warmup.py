"""Warm-up ping handling for the RAG Lambda handlers.

A daily EventBridge rule (cdk/lib/warmup.ts) invokes each container Lambda with
{"warmup": true} so Lambda never marks it Inactive. Each handler must return on
that flag before any S3, SQS, database or Bedrock work.
"""

from __future__ import annotations

import os
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest

# Module-level boto3 clients need a region at import time.
os.environ.setdefault("AWS_DEFAULT_REGION", "ca-central-1")

# Mock heavy dependencies that are only available in Docker
_MOCK_MODULES = [
    "fitz",
    "pptx",
    "pptx.enum",
    "pptx.enum.shapes",
    "docx",
    "pylatexenc",
    "pylatexenc.latexwalker",
]
for mod_name in _MOCK_MODULES:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = MagicMock()

# Patch Logger.inject_lambda_context to handle version differences in powertools
# (Docker runtime uses a newer version with log_uncaught_exceptions param)
from aws_lambda_powertools import Logger as _OrigLogger

_orig_inject = _OrigLogger.inject_lambda_context


def _compat_inject(self, *args, **kwargs):
    kwargs.pop("log_uncaught_exceptions", None)
    return _orig_inject(self, *args, **kwargs)


_OrigLogger.inject_lambda_context = _compat_inject

from .enrichment import handler as enrichment_handler  # noqa: E402
from .ingestion import handler as ingestion_handler  # noqa: E402
from .retrieval import handler as retrieval_handler  # noqa: E402

WARMUP_EVENT = {"warmup": True}


class _Ctx:
    """Minimal Lambda context for the powertools inject decorator."""

    function_name = "warmup-test"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:0:function:warmup-test"
    memory_limit_in_mb = 1024
    aws_request_id = "test-req-id"

    def get_remaining_time_in_millis(self) -> int:
        return 30000


def _fail(*_args: Any, **_kwargs: Any) -> None:
    raise AssertionError("warm-up ping must not reach the processing path")


@pytest.mark.parametrize(
    ("module", "processing_fn"),
    [
        (ingestion_handler, "_process_record"),
        (enrichment_handler, "_process_record"),
        (retrieval_handler, "_handle_query"),
    ],
    ids=["ingestion", "enrichment", "retrieval"],
)
def test_warmup_returns_before_processing(
    monkeypatch: pytest.MonkeyPatch, module: Any, processing_fn: str
) -> None:
    monkeypatch.setattr(module, processing_fn, _fail)

    assert module.handler(dict(WARMUP_EVENT), _Ctx()) == {"warmup": True}


def test_ingestion_warmup_skips_status_write_and_s3(monkeypatch: pytest.MonkeyPatch) -> None:
    status, s3 = MagicMock(), MagicMock()
    monkeypatch.setattr(ingestion_handler, "set_processing_status", status)
    monkeypatch.setattr(ingestion_handler, "_s3_client", s3)

    ingestion_handler.handler(dict(WARMUP_EVENT), _Ctx())

    status.assert_not_called()
    assert s3.method_calls == []


def test_falsy_warmup_flag_is_processed_normally(monkeypatch: pytest.MonkeyPatch) -> None:
    # Only a truthy flag short-circuits; an empty enrichment batch keeps its
    # existing behaviour.
    assert enrichment_handler.handler({"warmup": False, "Records": []}, _Ctx()) == {
        "batchItemFailures": []
    }
