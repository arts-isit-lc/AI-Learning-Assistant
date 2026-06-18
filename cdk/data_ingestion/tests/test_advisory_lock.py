"""Unit tests for the PostgreSQL advisory lock functions."""

import importlib.util
import os
from unittest.mock import MagicMock

import pytest

# Load the module directly to avoid the __init__.py pulling in heavy dependencies
# (incremental.py requires langchain_core which isn't installed for local testing)
_module_path = os.path.join(
    os.path.dirname(__file__), "..", "src", "indexing", "incremental.py"
)
_spec = importlib.util.spec_from_file_location("incremental", _module_path)

# Mock heavy dependencies before loading the module
import sys
sys.modules.setdefault("aws_lambda_powertools", MagicMock())
sys.modules.setdefault("langchain_core", MagicMock())
sys.modules.setdefault("langchain_core.documents", MagicMock())
sys.modules.setdefault("langchain_postgres", MagicMock())

_incremental = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_incremental)

acquire_module_lock = _incremental.acquire_module_lock
release_module_lock = _incremental.release_module_lock


def _make_connection(fetchone_return):
    """Helper to create a mock connection with cursor context manager."""
    connection = MagicMock()
    cursor = MagicMock()
    cursor.fetchone.return_value = fetchone_return
    cursor.__enter__ = MagicMock(return_value=cursor)
    cursor.__exit__ = MagicMock(return_value=False)
    connection.cursor.return_value = cursor
    return connection, cursor


class TestAcquireModuleLock:
    """Tests for acquire_module_lock()."""

    def test_returns_true_when_lock_acquired(self):
        connection, cursor = _make_connection(fetchone_return=(True,))
        result = acquire_module_lock("module-uuid-123", connection)
        assert result is True

    def test_returns_false_when_lock_not_acquired(self):
        connection, cursor = _make_connection(fetchone_return=(False,))
        result = acquire_module_lock("module-uuid-123", connection)
        assert result is False

    def test_executes_correct_sql(self):
        connection, cursor = _make_connection(fetchone_return=(True,))
        acquire_module_lock("module-uuid-456", connection)

        cursor.execute.assert_called_once_with(
            "SELECT pg_try_advisory_lock(hashtext(%s)::bigint)",
            ("module-uuid-456",),
        )

    def test_returns_false_when_fetchone_returns_none(self):
        connection, cursor = _make_connection(fetchone_return=None)
        result = acquire_module_lock("module-uuid-123", connection)
        assert result is False

    def test_uses_module_id_as_lock_key(self):
        """Different module_ids should produce different lock queries."""
        conn_a, cursor_a = _make_connection(fetchone_return=(True,))
        conn_b, cursor_b = _make_connection(fetchone_return=(True,))

        acquire_module_lock("module-A", conn_a)
        acquire_module_lock("module-B", conn_b)

        # Verify each call uses the correct module_id
        cursor_a.execute.assert_called_once_with(
            "SELECT pg_try_advisory_lock(hashtext(%s)::bigint)",
            ("module-A",),
        )
        cursor_b.execute.assert_called_once_with(
            "SELECT pg_try_advisory_lock(hashtext(%s)::bigint)",
            ("module-B",),
        )


class TestReleaseModuleLock:
    """Tests for release_module_lock()."""

    def test_executes_correct_sql(self):
        connection, cursor = _make_connection(fetchone_return=(True,))
        release_module_lock("module-uuid-789", connection)

        cursor.execute.assert_called_once_with(
            "SELECT pg_advisory_unlock(hashtext(%s)::bigint)",
            ("module-uuid-789",),
        )

    def test_does_not_raise_when_lock_was_not_held(self):
        """pg_advisory_unlock returns False if the lock wasn't held — should not raise."""
        connection, cursor = _make_connection(fetchone_return=(False,))
        # Should not raise
        release_module_lock("module-uuid-123", connection)

    def test_does_not_raise_when_fetchone_returns_none(self):
        connection, cursor = _make_connection(fetchone_return=None)
        # Should not raise
        release_module_lock("module-uuid-123", connection)

    def test_uses_same_hash_function_as_acquire(self):
        """Release must use the same hashtext approach as acquire for lock identity."""
        conn_acquire, cursor_acquire = _make_connection(fetchone_return=(True,))
        conn_release, cursor_release = _make_connection(fetchone_return=(True,))

        module_id = "test-module-xyz"
        acquire_module_lock(module_id, conn_acquire)
        release_module_lock(module_id, conn_release)

        # Both should use hashtext(%s)::bigint with the same module_id
        acquire_sql = cursor_acquire.execute.call_args[0][0]
        release_sql = cursor_release.execute.call_args[0][0]

        assert "hashtext(%s)::bigint" in acquire_sql
        assert "hashtext(%s)::bigint" in release_sql
        assert cursor_acquire.execute.call_args[0][1] == (module_id,)
        assert cursor_release.execute.call_args[0][1] == (module_id,)
