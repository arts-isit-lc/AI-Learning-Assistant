"""Content deduplication for the data ingestion pipeline.

Provides SHA-256 content hashing and deduplication checks to skip
reprocessing of unchanged files. Uses the Module_Files.content_hash
column as the permanent deduplication mechanism.
"""

import hashlib

from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")


def compute_content_hash(file_bytes: bytes) -> str:
    """Compute SHA-256 hash of file content bytes.

    Args:
        file_bytes: Raw bytes of the file content.

    Returns:
        Hex digest string of the SHA-256 hash.
    """
    return hashlib.sha256(file_bytes).hexdigest()


def should_reprocess_file(file_id: str, content_hash: str, connection) -> bool:
    """Check whether a file needs reprocessing based on content hash comparison.

    Queries the stored content_hash in Module_Files for the given file_id
    and compares it against the provided hash.

    Args:
        file_id: The UUID primary key from the Module_Files table.
        content_hash: The SHA-256 hash of the current file content.
        connection: A psycopg2 database connection.

    Returns:
        True if the file should be processed (hash differs or no previous hash).
        False if the file can be skipped (hash matches stored value).
    """
    try:
        with connection.cursor() as cur:
            cur.execute(
                'SELECT content_hash FROM "Module_Files" WHERE file_id = %s',
                (file_id,),
            )
            result = cur.fetchone()

        if result is None:
            logger.info("No record found for file_id, processing required", extra={"file_id": file_id})
            return True

        stored_hash = result[0]

        if stored_hash is None:
            logger.info("No previous content hash stored, processing required", extra={"file_id": file_id})
            return True

        if stored_hash == content_hash:
            logger.info(
                "Content hash matches stored value, skipping processing",
                extra={"file_id": file_id, "content_hash": content_hash},
            )
            return False

        logger.info(
            "Content hash differs from stored value, processing required",
            extra={"file_id": file_id, "new_hash": content_hash, "stored_hash": stored_hash},
        )
        return True

    except Exception:
        logger.exception("Error checking content hash, defaulting to reprocess", extra={"file_id": file_id})
        try:
            connection.rollback()
        except Exception:
            pass
        return True


def update_content_hash(file_id: str, content_hash: str, connection) -> None:
    """Update the stored content_hash in Module_Files after successful processing.

    Args:
        file_id: The UUID primary key from the Module_Files table.
        content_hash: The SHA-256 hash to store.
        connection: A psycopg2 database connection.
    """
    try:
        with connection.cursor() as cur:
            cur.execute(
                'UPDATE "Module_Files" SET content_hash = %s WHERE file_id = %s',
                (content_hash, file_id),
            )
        connection.commit()
        logger.info("Content hash updated successfully", extra={"file_id": file_id, "content_hash": content_hash})
    except Exception:
        logger.exception("Failed to update content hash", extra={"file_id": file_id})
        connection.rollback()
        raise
