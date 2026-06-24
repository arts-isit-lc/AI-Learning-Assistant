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
