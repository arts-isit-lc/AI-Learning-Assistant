"""Tests for RDS message projection — validates persist_message_to_rds and log_engagement.

Validates:
- persist_message_to_rds inserts message with correct fields
- persist_message_to_rds updates session last_accessed
- persist_message_to_rds rolls back on error without raising
- log_engagement inserts engagement record
- log_engagement handles empty email gracefully
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, call, patch

import pytest

# Add the chatbot_v2/src directory to path for direct imports
sys.path.insert(0, os.path.dirname(__file__))

from rds_projection import persist_message_to_rds, log_engagement


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_connection() -> MagicMock:
    """Create a mock psycopg2 connection with cursor."""
    conn = MagicMock()
    cursor = MagicMock()
    conn.cursor.return_value = cursor
    return conn


# ---------------------------------------------------------------------------
# Tests: persist_message_to_rds
# ---------------------------------------------------------------------------


class TestPersistMessageToRds:
    """Tests for message persistence to RDS."""

    def test_inserts_student_message(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "session-123", "Hello AI", student_sent=True)

        cursor = conn.cursor.return_value
        # First execute: INSERT INTO Messages
        insert_call = cursor.execute.call_args_list[0]
        sql = insert_call[0][0]
        params = insert_call[0][1]
        assert 'INSERT INTO "Messages"' in sql
        assert params[0] == "session-123"
        assert params[1] is True
        assert params[2] == "Hello AI"

    def test_inserts_ai_message(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "session-456", "Here is the answer", student_sent=False)

        cursor = conn.cursor.return_value
        insert_call = cursor.execute.call_args_list[0]
        params = insert_call[0][1]
        assert params[1] is False
        assert params[2] == "Here is the answer"

    def test_updates_session_last_accessed(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "session-789", "msg", student_sent=True)

        cursor = conn.cursor.return_value
        # Second execute: UPDATE Sessions
        update_call = cursor.execute.call_args_list[1]
        sql = update_call[0][0]
        params = update_call[0][1]
        assert 'UPDATE "Sessions"' in sql
        assert "last_accessed" in sql
        assert params[0] == "session-789"

    def test_commits_after_success(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "s-1", "msg", student_sent=True)

        conn.commit.assert_called_once()

    def test_does_not_raise_on_error(self) -> None:
        conn = _make_connection()
        conn.cursor.return_value.execute.side_effect = Exception("DB down")

        # Should not raise
        persist_message_to_rds(conn, "s-1", "msg", student_sent=True)

    def test_rolls_back_on_error(self) -> None:
        conn = _make_connection()
        conn.cursor.return_value.execute.side_effect = Exception("DB down")

        persist_message_to_rds(conn, "s-1", "msg", student_sent=True)

        conn.rollback.assert_called_once()

    def test_closes_cursor_on_success(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "s-1", "msg", student_sent=True)

        conn.cursor.return_value.close.assert_called_once()

    def test_persists_blocks_as_json_for_ai_message(self) -> None:
        # Reproduces the history-reload bug: before the fix, blocks were never
        # written, so figures vanished when a past session was reloaded.
        conn = _make_connection()
        blocks = [
            {"type": "text", "content": "See figure 1"},
            {"type": "figure", "id": "fig-1"},
        ]

        persist_message_to_rds(
            conn, "session-blocks", "answer", student_sent=False, blocks=blocks
        )

        cursor = conn.cursor.return_value
        insert_call = cursor.execute.call_args_list[0]
        sql = insert_call[0][0]
        params = insert_call[0][1]
        assert "message_blocks" in sql
        assert "::jsonb" in sql
        # blocks serialized to JSON as the 4th positional param
        assert params[3] is not None
        assert '"type": "figure"' in params[3]
        assert "fig-1" in params[3]

    def test_persists_null_blocks_when_absent(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "s-noblocks", "answer", student_sent=False)

        params = conn.cursor.return_value.execute.call_args_list[0][0][1]
        # No blocks -> SQL NULL, not the literal JSON string "null"
        assert params[3] is None


# ---------------------------------------------------------------------------
# Tests: log_engagement
# ---------------------------------------------------------------------------


class TestLogEngagement:
    """Tests for engagement logging."""

    def test_inserts_engagement_record(self) -> None:
        conn = _make_connection()

        log_engagement(conn, "student@example.com", "course-1", "module-1", "message creation")

        cursor = conn.cursor.return_value
        insert_call = cursor.execute.call_args_list[0]
        sql = insert_call[0][0]
        params = insert_call[0][1]
        assert 'INSERT INTO "User_Engagement_Log"' in sql
        assert "course-1" in params
        assert "module-1" in params
        assert "message creation" in params
        assert "student@example.com" in params

    def test_handles_empty_email_gracefully(self) -> None:
        conn = _make_connection()

        # Should not raise, should not execute any SQL
        log_engagement(conn, "", "course-1", "module-1", "message creation")

        conn.cursor.return_value.execute.assert_not_called()

    def test_commits_after_success(self) -> None:
        conn = _make_connection()

        log_engagement(conn, "a@b.com", "c1", "m1", "AI message creation")

        conn.commit.assert_called_once()

    def test_does_not_raise_on_error(self) -> None:
        conn = _make_connection()
        conn.cursor.return_value.execute.side_effect = Exception("Constraint violation")

        # Should not raise
        log_engagement(conn, "a@b.com", "c1", "m1", "test")

    def test_rolls_back_on_error(self) -> None:
        conn = _make_connection()
        conn.cursor.return_value.execute.side_effect = Exception("Error")

        log_engagement(conn, "a@b.com", "c1", "m1", "test")

        conn.rollback.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: time_sent threading (message-ordering bug fix)
# ---------------------------------------------------------------------------


class TestTimeSentOrdering:
    """time_sent must reflect TURN time, not RDS-write time.

    Under ASYNC_RDS_PROJECTION, normal turns are written by the SQS consumer
    (delayed) while a guardrail-blocked turn is written synchronously. When
    time_sent is stamped CURRENT_TIMESTAMP at write time, a later blocked turn
    can get an earlier timestamp than a still-queued prior turn, reordering the
    UI history (which sorts by time_sent ASC). Passing an explicit time_sent
    fixes this at the source.
    """

    def test_uses_provided_time_sent_instead_of_current_timestamp(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(
            conn, "s-1", "msg", student_sent=True, time_sent="2026-07-03 10:00:00.000001"
        )

        insert_call = conn.cursor.return_value.execute.call_args_list[0]
        sql = insert_call[0][0]
        params = insert_call[0][1]
        # The INSERT binds the supplied timestamp instead of CURRENT_TIMESTAMP.
        assert "CURRENT_TIMESTAMP" not in sql
        assert "2026-07-03 10:00:00.000001" in params

    def test_defaults_to_current_timestamp_when_time_sent_absent(self) -> None:
        conn = _make_connection()

        persist_message_to_rds(conn, "s-1", "msg", student_sent=True)

        insert_call = conn.cursor.return_value.execute.call_args_list[0]
        sql = insert_call[0][0]
        params = insert_call[0][1]
        # Back-compat: no time_sent -> server clock, and no extra bind param.
        assert "CURRENT_TIMESTAMP" in sql
        assert len(params) == 4
