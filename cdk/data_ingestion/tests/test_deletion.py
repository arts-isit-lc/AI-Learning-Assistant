"""
Unit tests for handle_file_deletion().

Validates Requirements 4.1, 4.2, 4.3, 4.4:
- Resolves file_id from Module_Files (4.1)
- Deletes all associated vector embeddings (4.2)
- Updates processing_status to 'deleted' (4.3)
- Logs warning and skips if file_id not found (4.4)
"""

import sys
import os
from unittest.mock import MagicMock, patch, call

import pytest

# Add src to path so imports resolve
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from indexing.deletion import handle_file_deletion


@pytest.fixture
def mock_connection():
    """Create a mock psycopg2 connection with cursor."""
    conn = MagicMock()
    cursor = MagicMock()
    conn.cursor.return_value = cursor
    return conn, cursor


class TestHandleFileDeletion:
    """Tests for handle_file_deletion function."""

    def test_successful_deletion(self, mock_connection):
        """When file_id is resolved, deletes vectors and updates status."""
        conn, cursor = mock_connection
        file_id = "abc-123-def"

        # cursor.fetchone returns the file_id
        cursor.fetchone.return_value = (file_id,)
        # DELETE returns 5 rows affected
        cursor.rowcount = 5

        result = handle_file_deletion("mod-1", "lecture", "pdf", conn)

        assert result == {"deleted": 5, "status": "deleted", "file_id": file_id}

        # Verify the SQL queries were called correctly
        calls = cursor.execute.call_args_list

        # First call: SELECT file_id
        assert 'SELECT file_id FROM "Module_Files"' in calls[0][0][0]
        assert calls[0][0][1] == ("mod-1", "lecture", "pdf")

        # Second call: DELETE embeddings
        assert "DELETE FROM langchain_pg_embedding" in calls[1][0][0]
        assert calls[1][0][1] == (file_id,)

        # Third call: UPDATE processing_status
        assert 'UPDATE "Module_Files" SET processing_status' in calls[2][0][0]
        assert calls[2][0][1] == ("deleted", file_id)

        # Transaction committed
        conn.commit.assert_called_once()
        cursor.close.assert_called_once()

    def test_file_not_found_skips_gracefully(self, mock_connection):
        """When file_id cannot be resolved, returns skip result without error."""
        conn, cursor = mock_connection
        cursor.fetchone.return_value = None

        result = handle_file_deletion("mod-999", "missing", "pdf", conn)

        assert result == {"deleted": 0, "status": "skipped", "reason": "file_id not found"}

        # Should NOT attempt DELETE or UPDATE
        assert cursor.execute.call_count == 1  # Only the SELECT
        conn.commit.assert_not_called()
        cursor.close.assert_called_once()

    def test_zero_chunks_deleted(self, mock_connection):
        """When file exists but has no embeddings, still marks as deleted."""
        conn, cursor = mock_connection
        file_id = "file-no-chunks"

        cursor.fetchone.return_value = (file_id,)
        cursor.rowcount = 0

        result = handle_file_deletion("mod-2", "empty", "txt", conn)

        assert result == {"deleted": 0, "status": "deleted", "file_id": file_id}
        conn.commit.assert_called_once()

    def test_database_error_rolls_back(self, mock_connection):
        """When a database error occurs, transaction is rolled back."""
        conn, cursor = mock_connection
        cursor.fetchone.return_value = ("file-id-123",)
        cursor.execute.side_effect = [None, Exception("DB connection lost")]

        with pytest.raises(Exception, match="DB connection lost"):
            handle_file_deletion("mod-3", "broken", "pdf", conn)

        conn.rollback.assert_called_once()
        cursor.close.assert_called_once()

    def test_file_id_converted_to_string(self, mock_connection):
        """file_id from DB (possibly UUID) is converted to string."""
        conn, cursor = mock_connection

        # Simulate a UUID-like object returned from psycopg2
        import uuid
        raw_uuid = uuid.uuid4()
        cursor.fetchone.return_value = (raw_uuid,)
        cursor.rowcount = 3

        result = handle_file_deletion("mod-4", "doc", "docx", conn)

        assert result["file_id"] == str(raw_uuid)
        assert result["status"] == "deleted"
