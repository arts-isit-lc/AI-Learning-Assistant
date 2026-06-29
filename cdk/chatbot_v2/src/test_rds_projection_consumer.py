"""Tests for the async RDS projection consumer (#8).

Reuses the chatbot_v2 image, which imports psycopg2 at module load (not installed
locally) — a bare fake is injected before import.
"""
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import rds_projection_consumer as consumer  # noqa: E402


class _Ctx:
    function_name = "rds-projection-consumer"
    function_version = "$LATEST"
    invoked_function_arn = "arn:aws:lambda:ca-central-1:123456789012:function:rds-projection-consumer"
    memory_limit_in_mb = 256
    aws_request_id = "test-req-id"
    log_group_name = "/aws/lambda/rds-projection-consumer"
    log_stream_name = "test-stream"

    def get_remaining_time_in_millis(self):
        return 30000


def _record(body: dict):
    return {"body": json.dumps(body)}


class TestProject:
    def test_with_student_message_writes_student_and_ai(self, monkeypatch):
        monkeypatch.setattr(consumer, "_get_db_connection", lambda: MagicMock())
        persist, log = MagicMock(), MagicMock()
        monkeypatch.setattr(consumer, "persist_message_to_rds", persist)
        monkeypatch.setattr(consumer, "log_engagement", log)

        consumer._project({
            "session_id": "s", "message_content": "hi", "llm_output": "ans",
            "user_email": "a@b.c", "course_id": "c", "module_id": "m",
        })

        assert persist.call_count == 2  # student + AI message
        assert log.call_count == 2

    def test_initial_greeting_writes_ai_only(self, monkeypatch):
        monkeypatch.setattr(consumer, "_get_db_connection", lambda: MagicMock())
        persist, log = MagicMock(), MagicMock()
        monkeypatch.setattr(consumer, "persist_message_to_rds", persist)
        monkeypatch.setattr(consumer, "log_engagement", log)

        consumer._project({
            "session_id": "s", "message_content": "", "llm_output": "intro",
            "user_email": "a@b.c", "course_id": "c", "module_id": "m",
        })

        assert persist.call_count == 1  # AI only
        assert log.call_count == 1


class TestHandler:
    def test_processes_all_records(self, monkeypatch):
        proj = MagicMock()
        monkeypatch.setattr(consumer, "_project", proj)
        event = {"Records": [_record({"session_id": "s1"}), _record({"session_id": "s2"})]}
        out = consumer.handler(event, _Ctx())
        assert proj.call_count == 2
        assert out == {"batchItemFailures": []}

    def test_skips_unparseable_record(self, monkeypatch):
        proj = MagicMock()
        monkeypatch.setattr(consumer, "_project", proj)
        event = {"Records": [{"body": "not json"}, _record({"session_id": "s"})]}
        consumer.handler(event, _Ctx())
        assert proj.call_count == 1  # only the valid record

    def test_swallows_projection_errors(self, monkeypatch):
        monkeypatch.setattr(consumer, "_project", MagicMock(side_effect=RuntimeError("db down")))
        event = {"Records": [_record({"session_id": "s"})]}
        out = consumer.handler(event, _Ctx())  # must not raise
        assert out == {"batchItemFailures": []}
