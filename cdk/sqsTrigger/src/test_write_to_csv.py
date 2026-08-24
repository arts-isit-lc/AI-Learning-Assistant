"""Tests for sqsTrigger write_to_csv encoding.

main.py reads required env vars and imports psycopg2/boto3 at module load, none of
which are configured locally. We stub the env + the driver / boto3 clients into
sys.modules before importing main so the pure CSV-writing helper can be exercised
in isolation.

Regression: exported chat-log CSVs rendered multibyte characters as mojibake
("Pâtisserie" -> "PÃ¢tisserie", "68°F" -> "68Â°F") because the file was written
without a UTF-8 BOM, so Excel opened it with a legacy ANSI code page. The writer
now uses encoding="utf-8-sig".
"""

import json
import os
import sys
from types import SimpleNamespace

import pytest

# Required module-level env vars (read at import time in main.py).
os.environ.setdefault("SM_DB_CREDENTIALS", "test-secret")
os.environ.setdefault("REGION", "ca-central-1")
os.environ.setdefault("CHATLOGS_BUCKET", "test-bucket")
os.environ.setdefault("RDS_PROXY_ENDPOINT", "proxy.local")
os.environ.setdefault("APPSYNC_API_URL", "https://appsync.local/graphql")

# Stub external drivers/clients so `import main` resolves without AWS or a DB.
sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.modules.setdefault("httpx", SimpleNamespace(Client=lambda *a, **k: None))
sys.modules.setdefault(
    "boto3", SimpleNamespace(client=lambda *a, **k: SimpleNamespace())
)
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


def _read_rows(file_path):
    """Read the written CSV back the way a UTF-8-aware reader would.

    encoding="utf-8-sig" transparently strips the BOM if present, so the parsed
    cells contain the original characters (not a leading \\ufeff).
    """
    import csv

    with open(file_path, mode="r", newline="", encoding="utf-8-sig") as fh:
        return list(csv.reader(fh))


def test_multibyte_characters_round_trip():
    """Happy path: accented + degree/symbol content survives a write/read cycle."""
    rows = [
        ("u1", "Pâtisserie", "Crème brûlée", "s1", "Keep dough at 68° and 72°F", True,
         "complete", "2026-08-19 10:00:00"),
        ("u2", "Café Menu", "Naïve façade", "s2", "Comparé à 100 % — ½ portion", False,
         "incomplete", "2026-08-19 10:05:00"),
    ]

    file_path, file_name = main.write_to_csv(rows, "course-1", "prof@example.com")

    assert file_name.endswith(".csv")

    parsed = _read_rows(file_path)
    header, *data = parsed
    assert header[1] == "module_name"
    assert data[0][1] == "Pâtisserie"
    assert data[0][2] == "Crème brûlée"
    assert data[0][4] == "Keep dough at 68° and 72°F"
    assert data[1][1] == "Café Menu"
    assert data[1][4] == "Comparé à 100 % — ½ portion"


def test_file_has_utf8_bom():
    """The raw bytes must start with the UTF-8 BOM so Excel detects UTF-8."""
    rows = [("u1", "Pâtisserie", "c", "s1", "68°F", True, "complete", "2026-08-19 10:00:00")]

    file_path, _ = main.write_to_csv(rows, "course-bom", "prof@example.com")

    with open(file_path, "rb") as fh:
        raw = fh.read()

    assert raw.startswith(b"\xef\xbb\xbf"), "CSV must be written with a UTF-8 BOM"
    # The accented byte sequence for 'â' (C3 A2) must be present and not double-encoded.
    assert "Pâtisserie".encode("utf-8") in raw


def test_error_path_propagates(monkeypatch):
    """Error case: an unwritable target dir raises (caller logs + re-raises)."""
    def boom(*a, **k):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(main.os, "makedirs", boom)

    with pytest.raises(OSError):
        main.write_to_csv([], "course-x", "prof@example.com")


# --- handler error handling -------------------------------------------------

_LAMBDA_CONTEXT = SimpleNamespace(
    function_name="AILA-ApiGatewayStack-SQSTriggerDockerFunc",
    memory_limit_in_mb=512,
    invoked_function_arn=(
        "arn:aws:lambda:ca-central-1:123456789012:function:"
        "AILA-ApiGatewayStack-SQSTriggerDockerFunc"
    ),
    aws_request_id="req-1",
)


def _sqs_event(**body):
    return {"Records": [{"body": json.dumps(body)}]}


def test_handler_reraises_on_processing_failure(monkeypatch):
    """A worker failure must PROPAGATE so SQS retries and ultimately DLQs it.

    Regression: the handler used to `except ... continue` (and return 200), which
    told SQS the message succeeded — deleting it with no retry, no DLQ, and no
    completion signal to the instructor's Export button (endless spinner).
    """
    def boom(*a, **k):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(main, "query_chat_logs", boom)

    event = _sqs_event(course_id="c1", instructor_email="prof@x.com", request_id="r1")
    with pytest.raises(RuntimeError):
        main.handler(event, _LAMBDA_CONTEXT)


def test_handler_skips_malformed_message_without_processing(monkeypatch):
    """A message missing required fields is dropped (retrying can't fix it)."""
    called = {"queried": False}

    def spy(*a, **k):
        called["queried"] = True
        return []

    monkeypatch.setattr(main, "query_chat_logs", spy)

    # request_id omitted -> validation drops the record before any processing.
    event = _sqs_event(course_id="c1", instructor_email="prof@x.com")
    result = main.handler(event, _LAMBDA_CONTEXT)

    assert result["statusCode"] == 200
    assert called["queried"] is False
