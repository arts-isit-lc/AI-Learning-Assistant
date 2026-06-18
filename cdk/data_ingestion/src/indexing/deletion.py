"""
File deletion handler for S3 ObjectRemoved events.

Resolves file_id from Module_Files and removes all associated vector embeddings
so deleted content is no longer searchable. Updates processing_status to 'deleted'.

Requirements validated: 4.1, 4.2, 4.3, 4.4
"""

from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")


def handle_file_deletion(module_id: str, file_name: str, file_type: str, connection) -> dict:
    """
    Handle an S3 ObjectRemoved event by removing all vector embeddings
    for the deleted file and updating its processing status.

    Args:
        module_id: The module UUID the file belongs to.
        file_name: The filename (without extension).
        file_type: The file extension/type.
        connection: An active psycopg2 database connection.

    Returns:
        A dict with deletion results:
          - {"deleted": <count>, "status": "deleted", "file_id": <id>} on success
          - {"deleted": 0, "status": "skipped", "reason": "file_id not found"} if file not found
    """
    cur = connection.cursor()
    try:
        # Step 1: Resolve file_id from Module_Files
        cur.execute(
            'SELECT file_id FROM "Module_Files" WHERE module_id = %s AND filename = %s AND filetype = %s',
            (module_id, file_name, file_type),
        )
        result = cur.fetchone()

        if not result:
            logger.warning(
                "Cannot resolve file_id for deletion, skipping",
                extra={
                    "module_id": module_id,
                    "file_name": file_name,
                    "file_type": file_type,
                },
            )
            return {"deleted": 0, "status": "skipped", "reason": "file_id not found"}

        file_id = str(result[0])

        # Step 2: Delete all vector embeddings for this file
        cur.execute(
            "DELETE FROM langchain_pg_embedding WHERE cmetadata->>'file_id' = %s",
            (file_id,),
        )
        deleted_count = cur.rowcount

        # Step 3: Update processing_status to 'deleted'
        cur.execute(
            'UPDATE "Module_Files" SET processing_status = %s WHERE file_id = %s',
            ("deleted", file_id),
        )

        # Step 4: Commit the transaction
        connection.commit()

        logger.info(
            "File deletion completed",
            extra={
                "file_id": file_id,
                "module_id": module_id,
                "file_name": file_name,
                "file_type": file_type,
                "chunks_removed": deleted_count,
            },
        )

        return {"deleted": deleted_count, "status": "deleted", "file_id": file_id}

    except Exception:
        connection.rollback()
        logger.exception(
            "Failed to delete file vectors",
            extra={
                "module_id": module_id,
                "file_name": file_name,
                "file_type": file_type,
            },
        )
        raise
    finally:
        cur.close()
