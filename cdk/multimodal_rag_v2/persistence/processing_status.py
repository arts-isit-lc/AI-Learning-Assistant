"""Best-effort writer for ``Module_Files.processing_status``.

Surfaces the file's current pipeline stage to the instructor UI, which polls
``instructor/file_processing_statuses`` every few seconds. Shared by the
ingestion and enrichment handlers so a file visibly progresses
``pending -> ingesting -> enriching -> complete`` instead of sitting on a single
"processing" state for the whole run.

Best-effort by design: a status write must never fail or slow the pipeline, so
DB/config errors are logged and swallowed. ``psycopg2`` is imported lazily (as in
the handlers) so this module stays importable where the driver isn't installed
(local/test), and ``boto3`` is module-level so tests can patch it.
"""

from __future__ import annotations

import json
import os

import boto3
from aws_lambda_powertools import Logger

logger = Logger(service="multimodal-rag-status")


def set_processing_status(file_id: str, status: str) -> None:
    """Update ``Module_Files.processing_status`` for a single file (best-effort).

    Matches on the canonical ``Module_Files.file_id`` UUID (the primary key), the
    same key the enrichment completion writer uses.

    Args:
        file_id: Canonical ``Module_Files.file_id`` UUID.
        status: New ``processing_status`` value (e.g. ``"ingesting"``,
            ``"enriching"``).
    """
    db_proxy_endpoint = os.environ.get("DB_PROXY_ENDPOINT", "")
    db_secret_arn = os.environ.get("DB_SECRET_ARN", "")

    if not db_proxy_endpoint or not db_secret_arn:
        logger.warning(
            "Cannot update processing_status: DB not configured",
            extra={"file_id": file_id, "status": status},
        )
        return

    import psycopg2

    try:
        secrets_client = boto3.client("secretsmanager")
        secret = json.loads(
            secrets_client.get_secret_value(SecretId=db_secret_arn)["SecretString"]
        )
        conn = psycopg2.connect(
            dbname=secret["dbname"],
            user=secret["username"],
            password=secret["password"],
            host=db_proxy_endpoint,
            port=secret["port"],
            sslmode="require",
        )
        cur = conn.cursor()
        cur.execute(
            'UPDATE "Module_Files" SET processing_status = %s WHERE file_id = %s',
            (status, file_id),
        )
        conn.commit()
        updated = cur.rowcount
        cur.close()
        conn.close()
        if updated:
            logger.info(
                "processing_status updated",
                extra={"file_id": file_id, "status": status, "rows_updated": updated},
            )
        else:
            # A zero-row update means file_id matched no Module_Files row — surfaced
            # as a warning so a stuck stage isn't silently lost.
            logger.warning(
                "processing_status update matched no rows",
                extra={"file_id": file_id, "status": status},
            )
    except Exception:
        logger.exception(
            "Failed to update processing_status (best-effort)",
            extra={"file_id": file_id, "status": status},
        )
