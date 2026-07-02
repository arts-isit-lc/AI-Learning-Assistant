"""Seam tests for _persist_turn — the shared persistence helper (M5).

The recurring bug class was "two paths that persist differently". _persist_turn
unifies normal + tutor persistence: DynamoDB canonical text FIRST, then the RDS
projection carrying render blocks (async via SQS, or sync). These tests assert
the render blocks actually flow through both modes, so figure/table/formula
blocks survive a history reload.

psycopg2 isn't installed locally, so a fake is injected before importing main.
"""
from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

sys.modules.setdefault("psycopg2", SimpleNamespace(connect=lambda *a, **k: None))
sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402

BLOCKS = [{"type": "text", "content": "hi"}, {"type": "figure", "id": "img-1"}]


def test_async_mode_enqueues_blocks_to_sqs(monkeypatch):
    monkeypatch.setattr(main, "ASYNC_RDS_PROJECTION", True)
    monkeypatch.setattr(main, "RDS_PROJECTION_QUEUE_URL", "https://sqs/queue")
    monkeypatch.setattr(main, "persist_message_pair", MagicMock())
    sqs = MagicMock()
    monkeypatch.setattr(main, "_sqs_client", sqs)

    main._persist_turn("s1", "hello", "answer", BLOCKS, "e@b.com", "c1", "m1")

    # DynamoDB canonical text log is written first (source of truth).
    main.persist_message_pair.assert_called_once()
    # The RDS projection is enqueued WITH the render blocks in the payload.
    sqs.send_message.assert_called_once()
    body = json.loads(sqs.send_message.call_args.kwargs["MessageBody"])
    assert body["blocks"] == BLOCKS
    assert body["session_id"] == "s1"
    assert body["llm_output"] == "answer"


def test_sync_mode_writes_blocks_to_rds_on_ai_message(monkeypatch):
    monkeypatch.setattr(main, "ASYNC_RDS_PROJECTION", False)
    monkeypatch.setattr(main, "persist_message_pair", MagicMock())
    monkeypatch.setattr(main, "_get_db_connection", lambda: MagicMock())
    p2rds = MagicMock()
    monkeypatch.setattr(main, "persist_message_to_rds", p2rds)
    monkeypatch.setattr(main, "log_engagement", MagicMock())

    main._persist_turn("s1", "hello", "answer", BLOCKS, "e@b.com", "c1", "m1")

    main.persist_message_pair.assert_called_once()  # DynamoDB first
    # The AI message is persisted WITH blocks; the student message carries none.
    ai_calls = [c for c in p2rds.call_args_list if c.kwargs.get("student_sent") is False]
    student_calls = [c for c in p2rds.call_args_list if c.kwargs.get("student_sent") is True]
    assert len(ai_calls) == 1
    assert ai_calls[0].kwargs.get("blocks") == BLOCKS
    assert len(student_calls) == 1
    assert "blocks" not in student_calls[0].kwargs or student_calls[0].kwargs.get("blocks") is None


def test_dynamo_write_precedes_rds_even_if_rds_fails(monkeypatch):
    # RDS projection failure must not lose the canonical DynamoDB write.
    monkeypatch.setattr(main, "ASYNC_RDS_PROJECTION", False)
    dynamo = MagicMock()
    monkeypatch.setattr(main, "persist_message_pair", dynamo)
    monkeypatch.setattr(main, "_get_db_connection", lambda: (_ for _ in ()).throw(RuntimeError("db down")))
    monkeypatch.setattr(main, "persist_message_to_rds", MagicMock())
    monkeypatch.setattr(main, "log_engagement", MagicMock())

    # Must not raise — persistence is best-effort — and DynamoDB still ran.
    main._persist_turn("s1", "hello", "answer", BLOCKS, "e@b.com", "c1", "m1")
    dynamo.assert_called_once()
