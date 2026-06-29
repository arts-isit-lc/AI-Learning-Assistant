"""SQS consumer that performs the RDS message projection off the chatbot's
critical path (#8, ASYNC_RDS_PROJECTION).

Reuses the chatbot_v2 container image (it already has psycopg2 + rds_projection)
with a different CMD. Each SQS record carries one turn's projection payload; we
replay the same writes the synchronous path would have done. Best-effort per
record: failures are logged. The DynamoDB store remains the source of truth, so
a dropped projection never loses a message — it only delays the relational
UI-history view.
"""
from __future__ import annotations

import json
import os

import boto3
import psycopg2
from aws_lambda_powertools import Logger

from rds_projection import log_engagement, persist_message_to_rds

try:
    from aws_xray_sdk.core import patch_all, xray_recorder

    xray_recorder.configure(context_missing="LOG_ERROR")
    patch_all()
except Exception as e:  # pragma: no cover - bootstrap only
    print(f"X-Ray initialization failed (non-critical): {e}")

logger = Logger(service="rds-projection-consumer", log_uncaught_exceptions=True)

REGION = os.environ.get("REGION", "ca-central-1")
DB_SECRET_ARN = os.environ.get("DB_SECRET_ARN", "")
DB_PROXY_ENDPOINT = os.environ.get("DB_PROXY_ENDPOINT", "")

_secrets_client = boto3.client("secretsmanager", region_name=REGION)
_db_connection = None


def _get_db_connection():
    """Open (or reuse) a psycopg2 connection to RDS via the proxy (sslmode=require)."""
    global _db_connection
    if _db_connection is None or _db_connection.closed:
        secret = json.loads(
            _secrets_client.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"]
        )
        _db_connection = psycopg2.connect(
            f"dbname={secret['dbname']} user={secret['username']} password={secret['password']} "
            f"host={DB_PROXY_ENDPOINT} port={secret['port']} sslmode=require"
        )
    return _db_connection


def _project(payload: dict) -> None:
    """Replay one turn's RDS projection (student message + AI message + engagement)."""
    session_id = payload.get("session_id", "")
    message_content = payload.get("message_content") or ""
    llm_output = payload.get("llm_output") or ""
    user_email = payload.get("user_email", "")
    course_id = payload.get("course_id", "")
    module_id = payload.get("module_id", "")

    logger.append_keys(session_id=session_id, course_id=course_id)
    conn = _get_db_connection()
    if message_content:
        persist_message_to_rds(conn, session_id, message_content, student_sent=True)
        log_engagement(conn, user_email, course_id, module_id, "message creation")
    persist_message_to_rds(conn, session_id, llm_output, student_sent=False)
    log_engagement(conn, user_email, course_id, module_id, "AI message creation")


@logger.inject_lambda_context(clear_state=True)
def handler(event, context):
    """Process a batch of SQS records, one RDS projection each.

    Per-record errors are logged and swallowed (the underlying rds_projection
    helpers are already best-effort), so one bad record never fails the batch.
    """
    records = event.get("Records", [])
    logger.info("RDS projection batch received", extra={"record_count": len(records)})
    for record in records:
        try:
            payload = json.loads(record["body"])
        except Exception:
            logger.exception("Skipping unparseable SQS record")
            continue
        try:
            _project(payload)
        except Exception:
            logger.exception("RDS projection (async) failed for record")
    return {"batchItemFailures": []}
