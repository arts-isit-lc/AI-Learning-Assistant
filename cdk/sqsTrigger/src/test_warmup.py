"""Daily keep-warm ping (cdk/lib/warmup.ts) for the chat-log export Lambda.

Without the early return, an event with no "Records" raises ValueError, so the
scheduled ping would fail and be retried by EventBridge.
"""

import os
import sys

import pytest

# main.py reads these at import time.
for _name, _value in {
    "SM_DB_CREDENTIALS": "test-secret",
    "REGION": "ca-central-1",
    "CHATLOGS_BUCKET": "test-bucket",
    "RDS_PROXY_ENDPOINT": "localhost",
    "APPSYNC_API_URL": "https://example.invalid/graphql",
    "AWS_DEFAULT_REGION": "ca-central-1",
}.items():
    os.environ.setdefault(_name, _value)

sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


class _Ctx:
    function_name = "sqs-trigger"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:0:function:sqs-trigger"
    memory_limit_in_mb = 512
    aws_request_id = "test-req-id"

    def get_remaining_time_in_millis(self):
        return 30000


def test_warmup_ping_returns_before_db(monkeypatch):
    def _fail(*a, **k):
        raise AssertionError("warm-up ping must not touch the DB or S3")

    monkeypatch.setattr(main, "connect_to_db", _fail)
    monkeypatch.setattr(main, "query_chat_logs", _fail)

    assert main.handler({"warmup": True}, _Ctx()) == {"warmup": True}


def test_event_without_records_still_rejected():
    with pytest.raises(ValueError):
        main.handler({}, _Ctx())
