"""Unit tests for the content deduplication module."""

import hashlib
import importlib.util
import sys
import os
from unittest.mock import MagicMock, patch

import pytest

# Load the module directly to avoid the __init__.py pulling in heavy dependencies
# (incremental.py requires langchain_core which isn't installed for local testing)
_module_path = os.path.join(
    os.path.dirname(__file__), "..", "src", "indexing", "deduplication.py"
)
_spec = importlib.util.spec_from_file_location("deduplication", _module_path)
_dedup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_dedup)

compute_content_hash = _dedup.compute_content_hash
should_reprocess_file = _dedup.should_reprocess_file
update_content_hash = _dedup.update_content_hash


class TestComputeContentHash:
    """Tests for compute_content_hash()."""

    def test_returns_sha256_hex_digest(self):
        content = b"hello world"
        expected = hashlib.sha256(b"hello world").hexdigest()
        assert compute_content_hash(content) == expected

    def test_empty_bytes_produces_valid_hash(self):
        result = compute_content_hash(b"")
        expected = hashlib.sha256(b"").hexdigest()
        assert result == expected
        assert len(result) == 64  # SHA-256 hex digest is always 64 chars

    def test_different_content_produces_different_hash(self):
        hash1 = compute_content_hash(b"file content A")
        hash2 = compute_content_hash(b"file content B")
        assert hash1 != hash2

    def test_same_content_produces_same_hash(self):
        content = b"identical content"
        assert compute_content_hash(content) == compute_content_hash(content)


class TestShouldReprocessFile:
    """Tests for should_reprocess_file()."""

    def _make_connection(self, fetchone_return):
        """Helper to create a mock connection with cursor context manager."""
        connection = MagicMock()
        cursor = MagicMock()
        cursor.fetchone.return_value = fetchone_return
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        connection.cursor.return_value = cursor
        return connection

    def test_returns_true_when_no_record_found(self):
        connection = self._make_connection(fetchone_return=None)
        result = should_reprocess_file("file-123", "abc123hash", connection)
        assert result is True

    def test_returns_true_when_stored_hash_is_none(self):
        connection = self._make_connection(fetchone_return=(None,))
        result = should_reprocess_file("file-123", "abc123hash", connection)
        assert result is True

    def test_returns_false_when_hashes_match(self):
        content_hash = "a1b2c3d4e5f6"
        connection = self._make_connection(fetchone_return=(content_hash,))
        result = should_reprocess_file("file-123", content_hash, connection)
        assert result is False

    def test_returns_true_when_hashes_differ(self):
        connection = self._make_connection(fetchone_return=("old_hash_value",))
        result = should_reprocess_file("file-123", "new_hash_value", connection)
        assert result is True

    def test_returns_true_on_database_error(self):
        connection = MagicMock()
        cursor = MagicMock()
        cursor.execute.side_effect = Exception("DB connection lost")
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        connection.cursor.return_value = cursor
        result = should_reprocess_file("file-123", "abc123hash", connection)
        assert result is True
        connection.rollback.assert_called_once()

    def test_rollback_failure_does_not_prevent_return(self):
        """If rollback itself fails, should_reprocess_file still returns True."""
        connection = MagicMock()
        cursor = MagicMock()
        cursor.execute.side_effect = Exception("DB connection lost")
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        connection.cursor.return_value = cursor
        connection.rollback.side_effect = Exception("Connection closed")
        result = should_reprocess_file("file-123", "abc123hash", connection)
        assert result is True

    def test_queries_correct_table_and_column(self):
        connection = MagicMock()
        cursor = MagicMock()
        cursor.fetchone.return_value = ("some_hash",)
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        connection.cursor.return_value = cursor

        should_reprocess_file("file-uuid-456", "test_hash", connection)

        cursor.execute.assert_called_once_with(
            'SELECT content_hash FROM "Module_Files" WHERE file_id = %s',
            ("file-uuid-456",),
        )


class TestUpdateContentHash:
    """Tests for update_content_hash()."""

    def _make_connection(self):
        """Helper to create a mock connection with cursor context manager."""
        connection = MagicMock()
        cursor = MagicMock()
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        connection.cursor.return_value = cursor
        return connection, cursor

    def test_executes_update_query(self):
        connection, cursor = self._make_connection()
        update_content_hash("file-789", "new_hash_value", connection)

        cursor.execute.assert_called_once_with(
            'UPDATE "Module_Files" SET content_hash = %s WHERE file_id = %s',
            ("new_hash_value", "file-789"),
        )

    def test_commits_transaction_on_success(self):
        connection, cursor = self._make_connection()
        update_content_hash("file-789", "new_hash_value", connection)
        connection.commit.assert_called_once()

    def test_rollback_and_raise_on_error(self):
        connection = MagicMock()
        cursor = MagicMock()
        cursor.execute.side_effect = Exception("DB write error")
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        connection.cursor.return_value = cursor

        with pytest.raises(Exception, match="DB write error"):
            update_content_hash("file-789", "new_hash_value", connection)

        connection.rollback.assert_called_once()
