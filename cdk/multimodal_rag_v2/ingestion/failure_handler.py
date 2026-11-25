"""Marks a file 'failed' when the ingestion Lambda gives up on it.

Wired as the ingestion function's async on-failure destination
(cdk/lib/multimodal-rag-stack.ts). Lambda invokes it once the S3-triggered
event has failed every attempt (1 + 2 retries) or aged out. Without it, a crash
the handler can't catch (out of memory, timeout) left the file at 'ingesting',
and the instructor UI showed "Timed out" instead of "Processing failed"
(CLAUDE_HISTORY.md, 2026-11-24).

The event is Lambda's invocation record:
    {"requestContext": {"requestId", "condition", "approximateInvokeCount", ...},
     "requestPayload": <the original S3 event>,
     "responseContext": {...},
     "responsePayload": {"errorType", "errorMessage", ...}}
"""

from __future__ import annotations

import urllib.parse
from typing import Any

from aws_lambda_powertools import Logger

from ..persistence.processing_status import set_processing_status
from .s3_key import parse_s3_key

logger = Logger(service="multimodal-rag-ingestion-failure")


@logger.inject_lambda_context(clear_state=True)
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    # Daily EventBridge keep-warm ping (cdk/lib/warmup.ts).
    if event.get("warmup"):
        logger.info("Warm-up ping")
        return {"warmup": True}

    request_context = event.get("requestContext") or {}
    response = event.get("responsePayload")
    failure = {
        "ingestion_request_id": request_context.get("requestId"),
        "condition": request_context.get("condition"),
        "invoke_count": request_context.get("approximateInvokeCount"),
        "error_type": response.get("errorType") if isinstance(response, dict) else None,
        "error_message": response.get("errorMessage") if isinstance(response, dict) else None,
    }

    records = (event.get("requestPayload") or {}).get("Records") or []
    if not records:
        logger.warning("Ingestion failure record has no S3 records", extra=failure)

    marked: list[str] = []
    for record in records:
        raw_key = record.get("s3", {}).get("object", {}).get("key", "")
        key = urllib.parse.unquote_plus(raw_key)
        try:
            file_id = parse_s3_key(key)["file_id"]
        except ValueError:
            logger.warning("Failed ingestion event has an unexpected S3 key", extra={**failure, "s3_key": key})
            continue

        logger.error("Ingestion gave up on file; marking it failed", extra={**failure, "s3_key": key, "file_id": file_id})
        set_processing_status(file_id, "failed")
        marked.append(file_id)

    return {"marked_failed": marked}
