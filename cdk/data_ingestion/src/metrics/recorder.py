"""
Processing Metrics Recorder

Tracks per-file processing metrics (duration, chunk count, errors) and stores
them in the Module_Files.metadata JSONB column under the 'processing_metrics' key.
Also updates the processing_status column as a state machine transition.

Requirements validated: 7.1, 7.2, 7.3
"""

import json
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional

from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")


@dataclass
class ProcessingMetrics:
    """Per-file processing metrics stored in Module_Files.metadata JSONB.

    Attributes:
        processing_duration_ms: Wall-clock time for the entire processing in milliseconds.
        chunk_count: Number of chunks indexed into the vectorstore.
        embedding_count: Number of embeddings generated.
        last_error: Error message on failure (None on success).
        retry_count: Number of retries attempted (default 0).
    """

    processing_duration_ms: int
    chunk_count: int
    embedding_count: int
    last_error: Optional[str] = None
    retry_count: int = 0


def record_processing_metrics(file_id: str, metrics: ProcessingMetrics, connection) -> None:
    """Store processing metrics in Module_Files.metadata JSONB and update processing_status.

    Reads existing metadata, merges the 'processing_metrics' key (preserving other keys
    like topic_extraction), and writes the updated metadata back. Also updates the
    processing_status column based on whether last_error is set.

    Stored format:
        {
            "processing_metrics": {
                "processing_duration_ms": ...,
                "chunk_count": ...,
                "embedding_count": ...,
                "last_error": ...,
                "retry_count": ...,
                "last_processed_at": "<ISO timestamp>"
            }
        }

    Args:
        file_id: The UUID primary key from Module_Files.
        metrics: A ProcessingMetrics instance with the current run's data.
        connection: An active psycopg2 connection.

    Raises:
        Exception: Re-raises any database error after logging and rolling back.
    """
    cur = None
    try:
        cur = connection.cursor()

        # Step 1: Read existing metadata to merge (preserve other keys like topic_extraction)
        cur.execute(
            'SELECT metadata FROM "Module_Files" WHERE file_id = %s;',
            (file_id,),
        )
        row = cur.fetchone()

        existing = {}
        if row and row[0]:
            existing = row[0] if isinstance(row[0], dict) else json.loads(row[0])

        # Step 2: Build processing_metrics payload
        metrics_payload = asdict(metrics)
        metrics_payload["last_processed_at"] = datetime.now(timezone.utc).isoformat()

        # Step 3: Merge into existing metadata under 'processing_metrics' key
        existing["processing_metrics"] = metrics_payload

        # Step 4: Determine processing_status from metrics
        new_status = "failed" if metrics.last_error else "complete"

        # Step 5: Write updated metadata and processing_status atomically
        cur.execute(
            """
            UPDATE "Module_Files"
            SET metadata = %s::jsonb,
                processing_status = %s
            WHERE file_id = %s;
            """,
            (json.dumps(existing), new_status, file_id),
        )

        connection.commit()
        cur.close()

        logger.info(
            "Processing metrics recorded",
            extra={
                "file_id": file_id,
                "processing_duration_ms": metrics.processing_duration_ms,
                "chunk_count": metrics.chunk_count,
                "status": new_status,
            },
        )

    except Exception:
        logger.exception("Failed to record processing metrics", extra={"file_id": file_id})
        if cur:
            cur.close()
        connection.rollback()
        raise
