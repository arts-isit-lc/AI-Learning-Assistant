"""Ingestion Lambda handler.

Triggered by S3 ObjectCreated events. Parses uploaded course materials into
a DocumentIR and persists it to the IR bucket.

Flow: S3 event → parse key → download file → AdapterRegistry → IRBuilder → IRPersistence
"""

from __future__ import annotations

import json
import os
import urllib.parse
from typing import Any

# X-Ray bootstrap block (before other module-level code)
_xray_available = False
try:
    from aws_xray_sdk.core import patch_all, xray_recorder

    xray_recorder.configure(context_missing="LOG_ERROR")
    patch_all()
    _xray_available = True
except Exception as e:
    print(f"X-Ray initialization failed (non-critical): {e}")
    xray_recorder = None  # type: ignore[assignment]

import boto3
from aws_lambda_powertools import Logger

from ..models.data_models import FileMetadata
from ..persistence.ir_persistence import IRPersistence
from .adapter_registry import AdapterRegistry
from .adapters.csv_adapter import CsvAdapter
from .adapters.docx_adapter import DocxAdapter
from .adapters.html_adapter import HtmlAdapter
from .adapters.image_adapter import ImageAdapter
from .adapters.json_adapter import JsonAdapter
from .adapters.latex_adapter import LatexAdapter
from .adapters.pdf_adapter import PdfAdapter
from .adapters.pptx_adapter import PptxAdapter
from .exceptions import (
    ExtractionFailureError,
    FileSizeExceededError,
    UnsupportedFormatError,
)
from .ir_builder import IRBuilder

logger = Logger(service="multimodal-rag-ingestion", log_uncaught_exceptions=True)

# Environment variables
IR_BUCKET_NAME = os.environ.get("IR_BUCKET_NAME", "ir-bucket")
SOURCE_BUCKET_NAME = os.environ.get("SOURCE_BUCKET_NAME", "")
ENRICHMENT_QUEUE_URL = os.environ.get("ENRICHMENT_QUEUE_URL", "")

# Initialize AWS clients
_s3_client = boto3.client("s3")
_sqs_client = boto3.client("sqs")

# Initialize components
_registry = AdapterRegistry()
_registry.register(["pdf"], PdfAdapter())
_registry.register(["pptx"], PptxAdapter())
_registry.register(["docx"], DocxAdapter())
_registry.register(["html", "htm"], HtmlAdapter())
_registry.register(
    ["png", "jpeg", "jpg", "gif", "tiff", "tif", "bmp", "webp"], ImageAdapter()
)
_registry.register(["tex", "latex"], LatexAdapter())
_registry.register(["csv"], CsvAdapter())
_registry.register(["json"], JsonAdapter())

_ir_builder = IRBuilder()
_ir_persistence = IRPersistence(bucket_name=IR_BUCKET_NAME, s3_client=_s3_client)


def _parse_s3_key(key: str) -> dict[str, str]:
    """Parse course_id, module_id, and file_id from the S3 key path.

    Expected key format: courses/{course_id}/{module_id}/{filename}

    Args:
        key: The S3 object key from the event.

    Returns:
        Dict with course_id, module_id, file_id, and filename.

    Raises:
        ValueError: If the key does not match the expected format.
    """
    parts = key.split("/")
    if len(parts) < 4 or parts[0] != "courses":
        raise ValueError(
            f"S3 key does not match expected format "
            f"'courses/{{course_id}}/{{module_id}}/{{filename}}': {key}"
        )

    course_id = parts[1]
    module_id = parts[2]
    filename = parts[3]
    # file_id is filename without extension
    file_id = os.path.splitext(filename)[0]

    return {
        "course_id": course_id,
        "module_id": module_id,
        "file_id": file_id,
        "filename": filename,
    }


def _get_file_extension(filename: str) -> str:
    """Extract the file extension (without dot, lowercase)."""
    _, ext = os.path.splitext(filename)
    return ext.lstrip(".").lower()


def _upload_images_to_s3(document_ir, course_id: str, module_id: str) -> None:
    """Upload extracted images to S3 and store the S3 key in element metadata.

    Images are stored at: images/{course_id}/{module_id}/{element_id}.png
    The S3 key is added to element.metadata["image_s3_key"] so the enrichment
    pipeline can pass it through to retrieval_units for image escalation.

    Best-effort: logs failures per image but continues processing.
    """
    from ..models.data_models import ElementType

    image_count = 0
    for element in document_ir.elements:
        if element.element_type != ElementType.IMAGE:
            continue
        if not isinstance(element.content, bytes):
            continue

        s3_key = f"images/{course_id}/{module_id}/{element.element_id}.png"
        try:
            _s3_client.put_object(
                Bucket=IR_BUCKET_NAME,
                Key=s3_key,
                Body=element.content,
                ContentType="image/png",
            )
            element.metadata["image_s3_key"] = f"s3://{IR_BUCKET_NAME}/{s3_key}"
            image_count += 1
        except Exception:
            logger.warning(
                "Failed to upload image to S3, continuing",
                extra={"element_id": element.element_id, "s3_key": s3_key},
            )

    if image_count > 0:
        logger.info("Images uploaded to S3", extra={"image_count": image_count})


def _build_response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    """Build a Lambda response dict."""
    return {
        "statusCode": status_code,
        "body": body,
    }


@logger.inject_lambda_context(clear_state=True)
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Ingestion Lambda handler.

    Processes S3 ObjectCreated events by parsing uploaded course materials
    into DocumentIR and persisting to the IR bucket.

    Args:
        event: S3 ObjectCreated event payload.
        context: Lambda context object.

    Returns:
        Response dict with statusCode and body.
    """
    records = event.get("Records", [])
    if not records:
        logger.warning("No records in event")
        return _build_response(400, {"error": "No S3 records in event"})

    results: list[dict[str, Any]] = []

    for record in records:
        result = _process_record(record)
        results.append(result)

    # Return overall status based on individual results
    failures = [r for r in results if r.get("statusCode", 200) >= 400]
    if failures and len(failures) == len(results):
        # All records failed
        return _build_response(
            failures[0]["statusCode"],
            {"error": "All records failed", "details": results},
        )

    return _build_response(
        200,
        {"message": f"Processed {len(results)} records", "results": results},
    )


def _process_record(record: dict[str, Any]) -> dict[str, Any]:
    """Process a single S3 event record.

    Args:
        record: A single record from the S3 event.

    Returns:
        Result dict with status and details.
    """
    try:
        # Extract bucket and key from the S3 event record
        s3_info = record.get("s3", {})
        bucket = s3_info.get("bucket", {}).get("name", "")
        raw_key = s3_info.get("object", {}).get("key", "")
        # URL-decode the key (S3 events encode special characters)
        key = urllib.parse.unquote_plus(raw_key)
        file_size = s3_info.get("object", {}).get("size", 0)

        if not bucket or not key:
            logger.error("Missing bucket or key in S3 event record")
            return {"statusCode": 400, "error": "Missing bucket or key in event"}

        logger.append_keys(s3_bucket=bucket, s3_key=key)
        logger.info("Processing S3 object", extra={"file_size": file_size})

        # Parse the S3 key to extract identifiers
        key_parts = _parse_s3_key(key)
        course_id = key_parts["course_id"]
        module_id = key_parts["module_id"]
        file_id = key_parts["file_id"]
        filename = key_parts["filename"]
        extension = _get_file_extension(filename)

        logger.append_keys(
            course_id=course_id,
            module_id=module_id,
            file_id=file_id,
        )

        # Build FileMetadata
        file_metadata = FileMetadata(
            course_id=course_id,
            module_id=module_id,
            file_id=file_id,
            file_key=key,
            file_size=file_size,
            extension=extension,
        )

        # Download file from S3
        with _traced_subsegment("S3Download"):
            file_content = _download_file(bucket, key)

        # Process file through AdapterRegistry → RawElements
        with _traced_subsegment("AdapterExtraction"):
            raw_elements = _registry.process_file(file_content, file_metadata)

        logger.info(
            "Adapter extraction complete",
            extra={"raw_element_count": len(raw_elements)},
        )

        # Build DocumentIR
        with _traced_subsegment("IRBuild"):
            document_ir = _ir_builder.build(raw_elements, file_metadata)

        logger.info(
            "IR build complete",
            extra={
                "element_count": len(document_ir.elements),
                "ir_version": document_ir.ir_version,
            },
        )

        # Upload extracted images to S3 for later retrieval (image escalation)
        with _traced_subsegment("ImageUpload"):
            _upload_images_to_s3(document_ir, course_id, module_id)

        # Persist DocumentIR to S3
        with _traced_subsegment("IRPersist"):
            s3_path = _ir_persistence.persist(document_ir)

        logger.info("Ingestion complete", extra={"ir_s3_path": s3_path})

        # Send message to enrichment queue to trigger Layer 2 processing
        if ENRICHMENT_QUEUE_URL:
            _sqs_client.send_message(
                QueueUrl=ENRICHMENT_QUEUE_URL,
                MessageBody=json.dumps({
                    "ir_s3_path": s3_path,
                    "course_id": course_id,
                    "module_id": module_id,
                    "file_id": file_id,
                    "ir_bucket": IR_BUCKET_NAME,
                }),
            )
            logger.info("Enrichment queue message sent")
        else:
            logger.warning("ENRICHMENT_QUEUE_URL not configured, skipping enrichment trigger")

        return {
            "statusCode": 200,
            "file_id": file_id,
            "course_id": course_id,
            "module_id": module_id,
            "ir_s3_path": s3_path,
            "element_count": len(document_ir.elements),
        }

    except UnsupportedFormatError as exc:
        logger.warning("Unsupported file format", extra={"error": str(exc)})
        return {"statusCode": 400, "error": str(exc)}

    except FileSizeExceededError as exc:
        logger.warning("File size exceeded", extra={"error": str(exc)})
        return {"statusCode": 400, "error": str(exc)}

    except ExtractionFailureError as exc:
        logger.exception("Extraction failure")
        return {"statusCode": 500, "error": str(exc)}

    except ValueError as exc:
        logger.warning("Invalid S3 key format", extra={"error": str(exc)})
        return {"statusCode": 400, "error": str(exc)}

    except Exception as exc:
        logger.exception("Unexpected error during ingestion")
        return {"statusCode": 500, "error": f"Internal error: {type(exc).__name__}"}


def _download_file(bucket: str, key: str) -> bytes:
    """Download a file from S3.

    Args:
        bucket: S3 bucket name.
        key: S3 object key.

    Returns:
        Raw bytes of the file content.
    """
    response = _s3_client.get_object(Bucket=bucket, Key=key)
    return response["Body"].read()


class _NoopContext:
    """No-op context manager for when X-Ray is not available."""

    def __enter__(self) -> "_NoopContext":
        return self

    def __exit__(self, *args: Any) -> None:
        pass


def _traced_subsegment(name: str) -> Any:
    """Return an X-Ray subsegment context manager, or a no-op if X-Ray is unavailable."""
    if _xray_available and xray_recorder:
        return xray_recorder.in_subsegment(name)
    return _NoopContext()
