"""Incremental indexing engine for per-file vectorstore operations.

Architecture principle: "PGVector is the source of truth. LangChain is optional convenience."
All record management and deletion is raw SQL — no SQLRecordManager.
"""

from indexing.incremental import incremental_index, delete_file_vectors, IndexResult
from indexing.deduplication import should_reprocess_file, compute_content_hash, update_content_hash
from indexing.deletion import handle_file_deletion

__all__ = [
    "incremental_index",
    "delete_file_vectors",
    "IndexResult",
    "should_reprocess_file",
    "compute_content_hash",
    "update_content_hash",
    "handle_file_deletion",
]
