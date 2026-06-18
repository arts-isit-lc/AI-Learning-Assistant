"""Unit tests for ProcessingMetrics dataclass and record_processing_metrics().

Requirements validated: 7.1, 7.2, 7.3
"""

import importlib.util
import json
import os
from unittest.mock import MagicMock, patch, call
from datetime import datetime, timezone

import pytest

# Load the module directly to avoid heavy dependencies from __init__.py
_module_path = os.path.join(
    os.path.dirname(__file__), "..", "src", "metrics", "recorder.py"
)
_spec = importlib.util.spec_from_file_location("recorder", _module_path)
_recorder = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_recorder)

ProcessingMetrics = _recorder.ProcessingMetrics
record_processing_metrics = _recorder.record_processing_metrics


class TestProcessingMetricsDataclass:
    """Tests for the ProcessingMetrics dataclass."""

    def test_success_metrics_with_defaults(self):
        m = ProcessingMetrics(
            processing_duration_ms=5000,
            chunk_count=10,
            embedding_count=10,
        )
        assert m.processing_duration_ms == 5000
        assert m.chunk_count == 10
        assert m.embedding_count == 10
        assert m.last_error is None
        assert m.retry_count == 0

    def test_failure_metrics_with_error(self):
        m = ProcessingMetrics(
            processing_duration_ms=1200,
            chunk_count=0,
            embedding_count=0,
            last_error="ThrottlingException: Rate exceeded",
            retry_count=3,
        )
        assert m.last_error == "ThrottlingException: Rate exceeded"
        assert m.retry_count == 3

    def test_all_fields_explicit(self):
        m = ProcessingMetrics(
            processing_duration_ms=9999,
            chunk_count=42,
            embedding_count=42,
            last_error=None,
            retry_count=1,
        )
        assert m.processing_duration_ms == 9999
        assert m.chunk_count == 42
        assert m.embedding_count == 42
        assert m.last_error is None
        assert m.retry_count == 1


class TestRecordProcessingMetrics:
    """Tests for record_processing_metrics()."""

    def _make_connection(self, existing_metadata=None):
        """Helper to create a mock connection with cursor."""
        connection = MagicMock()
        cursor = MagicMock()
        # fetchone returns the existing metadata from Module_Files
        if existing_metadata is None:
            cursor.fetchone.return_value = None
        else:
            cursor.fetchone.return_value = (existing_metadata,)
        connection.cursor.return_value = cursor
        return connection, cursor

    def test_stores_metrics_on_success(self):
        connection, cursor = self._make_connection(existing_metadata=None)
        metrics = ProcessingMetrics(
            processing_duration_ms=5000,
            chunk_count=10,
            embedding_count=10,
        )

        record_processing_metrics("file-123", metrics, connection)

        # Verify UPDATE was called
        update_call = cursor.execute.call_args_list[1]  # second call is the UPDATE
        sql = update_call[0][0]
        params = update_call[0][1]

        assert 'UPDATE "Module_Files"' in sql
        assert "metadata" in sql
        assert "processing_status" in sql

        stored_json = json.loads(params[0])
        assert "processing_metrics" in stored_json
        assert stored_json["processing_metrics"]["processing_duration_ms"] == 5000
        assert stored_json["processing_metrics"]["chunk_count"] == 10
        assert stored_json["processing_metrics"]["embedding_count"] == 10
        assert stored_json["processing_metrics"]["last_error"] is None
        assert stored_json["processing_metrics"]["retry_count"] == 0
        assert "last_processed_at" in stored_json["processing_metrics"]

        # Status should be 'complete' on success (no last_error)
        assert params[1] == "complete"
        assert params[2] == "file-123"

    def test_stores_metrics_on_failure(self):
        connection, cursor = self._make_connection(existing_metadata=None)
        metrics = ProcessingMetrics(
            processing_duration_ms=1500,
            chunk_count=0,
            embedding_count=0,
            last_error="Bedrock timeout",
            retry_count=2,
        )

        record_processing_metrics("file-456", metrics, connection)

        update_call = cursor.execute.call_args_list[1]
        params = update_call[0][1]
        stored_json = json.loads(params[0])

        assert stored_json["processing_metrics"]["last_error"] == "Bedrock timeout"
        assert stored_json["processing_metrics"]["retry_count"] == 2

        # Status should be 'failed' when last_error is set
        assert params[1] == "failed"

    def test_preserves_existing_metadata_keys(self):
        existing = {
            "topic_extraction": {
                "topics": ["machine learning", "neural networks"],
                "s3_etag": "abc123",
            }
        }
        connection, cursor = self._make_connection(existing_metadata=existing)
        metrics = ProcessingMetrics(
            processing_duration_ms=8000,
            chunk_count=25,
            embedding_count=25,
        )

        record_processing_metrics("file-789", metrics, connection)

        update_call = cursor.execute.call_args_list[1]
        params = update_call[0][1]
        stored_json = json.loads(params[0])

        # topic_extraction should be preserved
        assert "topic_extraction" in stored_json
        assert stored_json["topic_extraction"]["topics"] == ["machine learning", "neural networks"]

        # processing_metrics should also be present
        assert "processing_metrics" in stored_json
        assert stored_json["processing_metrics"]["chunk_count"] == 25

    def test_overwrites_previous_processing_metrics(self):
        existing = {
            "topic_extraction": {"topics": ["physics"]},
            "processing_metrics": {
                "processing_duration_ms": 1000,
                "chunk_count": 5,
                "embedding_count": 5,
                "last_error": "old error",
                "retry_count": 1,
                "last_processed_at": "2024-01-01T00:00:00+00:00",
            },
        }
        connection, cursor = self._make_connection(existing_metadata=existing)
        metrics = ProcessingMetrics(
            processing_duration_ms=3000,
            chunk_count=15,
            embedding_count=15,
        )

        record_processing_metrics("file-789", metrics, connection)

        update_call = cursor.execute.call_args_list[1]
        params = update_call[0][1]
        stored_json = json.loads(params[0])

        # New metrics should overwrite old
        assert stored_json["processing_metrics"]["processing_duration_ms"] == 3000
        assert stored_json["processing_metrics"]["chunk_count"] == 15
        assert stored_json["processing_metrics"]["last_error"] is None

    def test_handles_metadata_as_json_string(self):
        """Metadata stored as a JSON string (not pre-parsed dict) should work."""
        existing_str = json.dumps({"topic_extraction": {"topics": ["biology"]}})
        connection, cursor = self._make_connection(existing_metadata=existing_str)
        metrics = ProcessingMetrics(
            processing_duration_ms=2000,
            chunk_count=8,
            embedding_count=8,
        )

        record_processing_metrics("file-abc", metrics, connection)

        update_call = cursor.execute.call_args_list[1]
        params = update_call[0][1]
        stored_json = json.loads(params[0])

        assert "topic_extraction" in stored_json
        assert "processing_metrics" in stored_json

    def test_commits_on_success(self):
        connection, cursor = self._make_connection(existing_metadata=None)
        metrics = ProcessingMetrics(
            processing_duration_ms=1000,
            chunk_count=5,
            embedding_count=5,
        )

        record_processing_metrics("file-123", metrics, connection)
        connection.commit.assert_called_once()

    def test_rollback_and_raise_on_db_error(self):
        connection = MagicMock()
        cursor = MagicMock()
        cursor.execute.side_effect = Exception("DB connection lost")
        connection.cursor.return_value = cursor

        metrics = ProcessingMetrics(
            processing_duration_ms=1000,
            chunk_count=5,
            embedding_count=5,
        )

        with pytest.raises(Exception, match="DB connection lost"):
            record_processing_metrics("file-123", metrics, connection)

        connection.rollback.assert_called_once()

    def test_last_processed_at_is_iso_timestamp(self):
        connection, cursor = self._make_connection(existing_metadata=None)
        metrics = ProcessingMetrics(
            processing_duration_ms=4000,
            chunk_count=20,
            embedding_count=20,
        )

        record_processing_metrics("file-ts", metrics, connection)

        update_call = cursor.execute.call_args_list[1]
        params = update_call[0][1]
        stored_json = json.loads(params[0])

        timestamp_str = stored_json["processing_metrics"]["last_processed_at"]
        # Should be parseable as ISO format
        parsed = datetime.fromisoformat(timestamp_str)
        assert parsed.tzinfo is not None  # Should be timezone-aware
