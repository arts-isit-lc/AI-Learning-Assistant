"""Incremental indexing engine — direct SQL delete+insert for per-file vectorstore operations.

Architecture principle: "PGVector is the source of truth. LangChain is optional convenience."
- All deletion and record management is raw SQL
- LangChain PGVector.add_documents() is used for insertion convenience only
- No SQLRecordManager, no cleanup="full"

Requirements validated: 2.1, 2.2, 2.3, 2.4
"""

from typing import List, TypedDict

from aws_lambda_powertools import Logger
from langchain_core.documents import Document
from langchain_postgres import PGVector

logger = Logger(service="data-ingestion")


class IndexResult(TypedDict):
    """Result of an incremental indexing operation."""

    deleted: int
    inserted: int


def acquire_module_lock(module_id: str, connection) -> bool:
    """Acquire a PostgreSQL advisory lock for a module to serialize concurrent access.

    Uses pg_try_advisory_lock with a hashtext-derived bigint key so that
    concurrent Lambda invocations processing the same module are serialized.
    The lock is session-level and must be explicitly released via release_module_lock().

    Args:
        module_id: The module UUID string used to derive the lock key.
        connection: A psycopg2 connection (the lock is bound to this session).

    Returns:
        True if the lock was acquired, False if another session holds it.

    Requirements validated: 15.3, 15.4
    """
    with connection.cursor() as cur:
        cur.execute(
            "SELECT pg_try_advisory_lock(hashtext(%s)::bigint)",
            (module_id,)
        )
        result = cur.fetchone()
        acquired = result[0] if result else False

    logger.info(
        "Advisory lock acquisition attempted",
        extra={"module_id": module_id, "acquired": acquired}
    )
    return acquired


def release_module_lock(module_id: str, connection) -> None:
    """Release a previously acquired PostgreSQL advisory lock for a module.

    Must be called after transaction commit/rollback to release the session-level
    advisory lock. Safe to call even if the lock was not acquired (pg_advisory_unlock
    returns False in that case, which we log but do not raise on).

    Args:
        module_id: The module UUID string used to derive the lock key.
        connection: The same psycopg2 connection that acquired the lock.

    Requirements validated: 15.3, 15.4
    """
    with connection.cursor() as cur:
        cur.execute(
            "SELECT pg_advisory_unlock(hashtext(%s)::bigint)",
            (module_id,)
        )
        result = cur.fetchone()
        released = result[0] if result else False

    logger.info(
        "Advisory lock released",
        extra={"module_id": module_id, "released": released}
    )


def _resolve_collection_id(collection_name: str, cursor) -> str:
    """Resolve the collection UUID from the collection name.

    The langchain_pg_collection table maps collection names to UUIDs.
    The langchain_pg_embedding table references collections by UUID.

    Args:
        collection_name: The collection name (module_id in this system).
        cursor: An active database cursor.

    Returns:
        The collection UUID as a string.

    Raises:
        ValueError: If the collection does not exist.
    """
    cursor.execute(
        'SELECT uuid FROM langchain_pg_collection WHERE name = %s',
        (collection_name,)
    )
    result = cursor.fetchone()
    if result is None:
        raise ValueError(f"Collection '{collection_name}' not found in langchain_pg_collection")
    return str(result[0])


def delete_file_vectors(file_id: str, collection_name: str, connection) -> int:
    """Remove all vector embeddings for a file from the vectorstore.

    Executes direct SQL deletion scoped to the file_id and collection.
    This is the canonical way to remove stale vectors when a file is
    re-uploaded or deleted.

    Args:
        file_id: The UUID of the file (from Module_Files table).
        collection_name: The collection name (module_id).
        connection: A psycopg2 connection (caller manages commit/rollback).

    Returns:
        The number of deleted rows.
    """
    with connection.cursor() as cur:
        collection_id = _resolve_collection_id(collection_name, cur)

        cur.execute(
            "DELETE FROM langchain_pg_embedding "
            "WHERE cmetadata->>'file_id' = %s AND collection_id = %s",
            (file_id, str(collection_id))
        )
        deleted_count = cur.rowcount

    logger.info(
        "Deleted file vectors",
        extra={"file_id": file_id, "collection_name": collection_name, "deleted_count": deleted_count}
    )
    return deleted_count


def incremental_index(
    file_id: str,
    chunks: List[Document],
    vectorstore: PGVector,
    connection,
    collection_name: str,
) -> IndexResult:
    """Upsert chunks for a single file using direct SQL delete + LangChain insert.

    Performs an atomic delete-then-insert within a single transaction:
    1. DELETE old chunks for this file_id (direct SQL)
    2. INSERT new chunks via PGVector.add_documents() (LangChain convenience)

    The caller is responsible for calling connection.commit() or
    connection.rollback() after this function returns — this keeps the
    transaction boundary explicit and composable with other operations
    (e.g., advisory locks, status updates).

    Args:
        file_id: The UUID of the file (from Module_Files table).
        chunks: List of LangChain Document objects with mandatory metadata
            including file_id, source, doc_id, page_numbers, chunk_index, content_hash.
        vectorstore: A PGVector instance configured for this collection.
        connection: A psycopg2 connection (caller manages commit/rollback).
        collection_name: The collection name (module_id).

    Returns:
        IndexResult with deleted and inserted counts.

    Raises:
        ValueError: If collection_name does not exist in the database.
        Exception: Any database error — caller should rollback.
    """
    # Step 1: Delete old chunks for this file_id (direct SQL)
    deleted_count = delete_file_vectors(file_id, collection_name, connection)

    # Step 2: Insert new chunks via PGVector.add_documents()
    # LangChain PGVector handles embedding generation and SQL INSERT internally.
    inserted_count = 0
    if chunks:
        vectorstore.add_documents(chunks)
        inserted_count = len(chunks)

    # Commit the transaction to make both operations atomic
    connection.commit()

    logger.info(
        "Incremental index complete",
        extra={
            "file_id": file_id,
            "collection_name": collection_name,
            "deleted_count": deleted_count,
            "inserted_count": inserted_count,
        }
    )

    return IndexResult(deleted=deleted_count, inserted=inserted_count)
