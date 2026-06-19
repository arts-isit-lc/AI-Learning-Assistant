"""IRPersistence stores and retrieves DocumentIR from S3.

Storage path: s3://ir-bucket/{course}/{module}/{file}/ir_v{version}/document_ir.json

Supports version coexistence: different ir_versions stored at different paths
without overwriting prior versions.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import asdict
from typing import Any

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

from ..models.data_models import (
    DocumentIR,
    ElementType,
    FileMetadata,
    IRElement,
    IR_VERSION,
    Provenance,
)
from .exceptions import IRNotFoundError

logger = Logger(service="multimodal-rag-persistence")

# S3 bucket name from environment variable or fallback
IR_BUCKET_NAME = os.environ.get("IR_BUCKET_NAME", "ir-bucket")


class IRPersistence:
    """Persists DocumentIR to S3 enabling re-enrichment without re-parsing.

    Storage path: s3://{bucket}/{course}/{module}/{file}/ir_v{version}/document_ir.json

    Responsibilities:
    - Serialize DocumentIR to JSON (base64-encoding binary content)
    - Store at versioned S3 path
    - Load and deserialize from S3
    - Handle missing/corrupted documents gracefully
    """

    def __init__(self, bucket_name: str | None = None, s3_client: Any | None = None) -> None:
        """Initialize IRPersistence.

        Args:
            bucket_name: S3 bucket name. Defaults to IR_BUCKET_NAME env var.
            s3_client: Optional boto3 S3 client for dependency injection (testing).
        """
        self._bucket_name = bucket_name or IR_BUCKET_NAME
        self._s3_client = s3_client or boto3.client("s3")

    def _build_s3_key(
        self, course_id: str, module_id: str, file_id: str, ir_version: str
    ) -> str:
        """Build the S3 object key for a DocumentIR.

        Path format: {course}/{module}/{file}/ir_v{version}/document_ir.json
        """
        return f"{course_id}/{module_id}/{file_id}/ir_v{ir_version}/document_ir.json"

    def _serialize_element(self, element: IRElement) -> dict[str, Any]:
        """Serialize a single IRElement to a JSON-compatible dict.

        Binary content (images) is base64-encoded. ElementType is stored as
        its string value. Provenance is stored as a dict.
        """
        content: str
        content_is_binary: bool = False

        if isinstance(element.content, bytes):
            content = base64.b64encode(element.content).decode("utf-8")
            content_is_binary = True
        else:
            content = element.content

        return {
            "element_id": element.element_id,
            "content": content,
            "content_is_binary": content_is_binary,
            "element_type": element.element_type.value,
            "provenance": asdict(element.provenance),
            "content_hash": element.content_hash,
            "metadata": element.metadata,
        }

    def _serialize_document_ir(self, document_ir: DocumentIR) -> dict[str, Any]:
        """Serialize a DocumentIR to a JSON-compatible dict."""
        return {
            "file_metadata": asdict(document_ir.file_metadata),
            "elements": [self._serialize_element(el) for el in document_ir.elements],
            "element_count": {
                etype.value: count
                for etype, count in document_ir.element_count.items()
            },
            "ir_version": document_ir.ir_version,
        }

    def _deserialize_element(self, data: dict[str, Any]) -> IRElement:
        """Deserialize a single IRElement from a dict.

        Base64-encoded binary content is decoded back to bytes.
        """
        content: bytes | str
        if data.get("content_is_binary", False):
            content = base64.b64decode(data["content"])
        else:
            content = data["content"]

        provenance_data = data["provenance"]
        provenance = Provenance(
            page_num=provenance_data.get("page_num"),
            slide_num=provenance_data.get("slide_num"),
            section=provenance_data.get("section"),
            position_index=provenance_data.get("position_index", 0),
        )

        return IRElement(
            element_id=data["element_id"],
            content=content,
            element_type=ElementType(data["element_type"]),
            provenance=provenance,
            content_hash=data["content_hash"],
            metadata=data.get("metadata", {}),
        )

    def _deserialize_document_ir(self, data: dict[str, Any]) -> DocumentIR:
        """Deserialize a DocumentIR from a dict."""
        fm_data = data["file_metadata"]
        file_metadata = FileMetadata(
            course_id=fm_data["course_id"],
            module_id=fm_data["module_id"],
            file_id=fm_data["file_id"],
            file_key=fm_data["file_key"],
            file_size=fm_data["file_size"],
            extension=fm_data["extension"],
        )

        elements = [self._deserialize_element(el) for el in data["elements"]]

        element_count: dict[ElementType, int] = {}
        for type_str, count in data.get("element_count", {}).items():
            element_count[ElementType(type_str)] = count

        return DocumentIR(
            file_metadata=file_metadata,
            elements=elements,
            element_count=element_count,
            ir_version=data.get("ir_version", IR_VERSION),
        )

    def persist(self, document_ir: DocumentIR) -> str:
        """Persist a DocumentIR to S3.

        Stores at path: s3://{bucket}/{course}/{module}/{file}/ir_v{version}/document_ir.json
        Different ir_versions are stored at different paths without overwriting.

        Args:
            document_ir: The intermediate representation to persist.

        Returns:
            The S3 path where the DocumentIR was stored.
        """
        fm = document_ir.file_metadata
        s3_key = self._build_s3_key(
            course_id=fm.course_id,
            module_id=fm.module_id,
            file_id=fm.file_id,
            ir_version=document_ir.ir_version,
        )

        serialized = self._serialize_document_ir(document_ir)
        body = json.dumps(serialized, ensure_ascii=False)

        self._s3_client.put_object(
            Bucket=self._bucket_name,
            Key=s3_key,
            Body=body.encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )

        s3_path = f"s3://{self._bucket_name}/{s3_key}"
        logger.info(
            "Persisted DocumentIR",
            extra={
                "s3_path": s3_path,
                "course_id": fm.course_id,
                "module_id": fm.module_id,
                "file_id": fm.file_id,
                "ir_version": document_ir.ir_version,
                "element_count": len(document_ir.elements),
            },
        )
        return s3_path

    def load(
        self,
        course_id: str,
        module_id: str,
        file_id: str,
        ir_version: str | None = None,
    ) -> DocumentIR:
        """Load a DocumentIR from S3.

        Args:
            course_id: The course identifier.
            module_id: The module identifier.
            file_id: The file identifier.
            ir_version: The IR version to load. Defaults to the current IR_VERSION.

        Returns:
            The deserialized DocumentIR.

        Raises:
            IRNotFoundError: If the DocumentIR does not exist at the expected path
                or the stored JSON is corrupted.
        """
        version = ir_version or IR_VERSION
        s3_key = self._build_s3_key(course_id, module_id, file_id, version)
        s3_path = f"s3://{self._bucket_name}/{s3_key}"

        try:
            response = self._s3_client.get_object(
                Bucket=self._bucket_name,
                Key=s3_key,
            )
            body = response["Body"].read().decode("utf-8")
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in ("NoSuchKey", "404"):
                logger.warning(
                    "DocumentIR not found",
                    extra={
                        "s3_path": s3_path,
                        "course_id": course_id,
                        "module_id": module_id,
                        "file_id": file_id,
                    },
                )
                raise IRNotFoundError(
                    s3_path=s3_path,
                    course_id=course_id,
                    module_id=module_id,
                    file_id=file_id,
                    reason="not found",
                ) from exc
            # Other S3 errors (permissions, network, etc.)
            logger.exception(
                "S3 error loading DocumentIR",
                extra={
                    "s3_path": s3_path,
                    "error_code": error_code,
                    "course_id": course_id,
                    "module_id": module_id,
                    "file_id": file_id,
                },
            )
            raise IRNotFoundError(
                s3_path=s3_path,
                course_id=course_id,
                module_id=module_id,
                file_id=file_id,
                reason=f"S3 error: {error_code}",
            ) from exc

        try:
            data = json.loads(body)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.exception(
                "Corrupted DocumentIR JSON",
                extra={
                    "s3_path": s3_path,
                    "course_id": course_id,
                    "module_id": module_id,
                    "file_id": file_id,
                },
            )
            raise IRNotFoundError(
                s3_path=s3_path,
                course_id=course_id,
                module_id=module_id,
                file_id=file_id,
                reason="corrupted JSON",
            ) from exc

        try:
            document_ir = self._deserialize_document_ir(data)
        except (KeyError, TypeError, ValueError) as exc:
            logger.exception(
                "Failed to deserialize DocumentIR",
                extra={
                    "s3_path": s3_path,
                    "course_id": course_id,
                    "module_id": module_id,
                    "file_id": file_id,
                },
            )
            raise IRNotFoundError(
                s3_path=s3_path,
                course_id=course_id,
                module_id=module_id,
                file_id=file_id,
                reason="deserialization failed",
            ) from exc

        logger.info(
            "Loaded DocumentIR",
            extra={
                "s3_path": s3_path,
                "course_id": course_id,
                "module_id": module_id,
                "file_id": file_id,
                "ir_version": document_ir.ir_version,
                "element_count": len(document_ir.elements),
            },
        )
        return document_ir
