"""Legacy vectorstore helper module.

This module is retained for backwards compatibility but is no longer
called from main.py. The incremental pipeline uses add_document() +
incremental_index() directly instead of the full-module update_vectorstore flow.
"""

from typing import Dict

from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")


def update_vectorstore(
    bucket: str,
    course: str,
    module: str,
    vectorstore_config_dict: Dict[str, str],
    embeddings,
    file_id: str = None
) -> None:
    """
    Legacy function — no longer called from the main handler.

    Previously updated the vectorstore with embeddings for all documents in the S3 bucket
    using SQLRecordManager and cleanup="full". Now replaced by incremental_index() in main.py.

    This function is kept for backwards compatibility but will log a deprecation warning
    if called.
    """
    logger.warning(
        "update_vectorstore is deprecated — use incremental_index() instead",
        extra={"module": module, "bucket": bucket},
    )
