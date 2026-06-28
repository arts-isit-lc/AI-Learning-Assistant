"""Tests for the ingestion Lambda handler.

Uses mock patching to avoid importing heavy adapter dependencies (PyMuPDF, etc.)
that are only available in the Docker container runtime.
"""

from __future__ import annotations

import sys
from typing import Any
from unittest.mock import MagicMock

import pytest

# Mock heavy dependencies that are only available in Docker
_MOCK_MODULES = [
    "fitz",
    "pptx",
    "pptx.enum",
    "pptx.enum.shapes",
    "docx",
    "pylatexenc",
    "pylatexenc.latexwalker",
]
for mod_name in _MOCK_MODULES:
    if mod_name not in sys.modules:
        sys.modules[mod_name] = MagicMock()

# Patch Logger.inject_lambda_context to handle version differences in powertools
# (Docker runtime uses a newer version with log_uncaught_exceptions param)
from aws_lambda_powertools import Logger as _OrigLogger

_orig_inject = _OrigLogger.inject_lambda_context


def _compat_inject(self, *args, **kwargs):
    kwargs.pop("log_uncaught_exceptions", None)
    return _orig_inject(self, *args, **kwargs)


_OrigLogger.inject_lambda_context = _compat_inject

from ..models.data_models import (
    DocumentIR,
    ElementType,
    FileMetadata,
    IRElement,
    IR_VERSION,
    Provenance,
    RawElement,
)
from .exceptions import (
    ExtractionFailureError,
    FileSizeExceededError,
    UnsupportedFormatError,
)
from . import handler as handler_module
from .handler import _parse_s3_key, handler


def _make_s3_event(
    bucket: str = "test-bucket",
    key: str = "courses/course-1/module-1/lecture.pdf",
    size: int = 1024,
) -> dict[str, Any]:
    """Create a minimal S3 ObjectCreated event."""
    return {
        "Records": [
            {
                "s3": {
                    "bucket": {"name": bucket},
                    "object": {"key": key, "size": size},
                }
            }
        ]
    }


def _mock_lambda_context() -> MagicMock:
    """Create a mock Lambda context object."""
    ctx = MagicMock()
    ctx.function_name = "test-ingestion"
    ctx.memory_limit_in_mb = 512
    ctx.invoked_function_arn = "arn:aws:lambda:us-east-1:123456789012:function:test-ingestion"
    ctx.aws_request_id = "test-request-id-12345"
    return ctx


class TestParseS3Key:
    def test_valid_key_parses_correctly(self) -> None:
        result = _parse_s3_key("courses/course-1/module-2/Lecture_7.pdf")
        assert result["course_id"] == "course-1"
        assert result["module_id"] == "module-2"
        assert result["file_id"] == "Lecture_7"
        assert result["filename"] == "Lecture_7.pdf"

    def test_key_with_nested_path(self) -> None:
        result = _parse_s3_key("courses/cs101/week-3/notes.docx")
        assert result["course_id"] == "cs101"
        assert result["module_id"] == "week-3"
        assert result["file_id"] == "notes"
        assert result["filename"] == "notes.docx"

    def test_uuid_keyed_path_yields_uuid_file_id(self) -> None:
        # Cross-module referencing: the upload key now uses the canonical UUID
        # file_id as the object name, so file_id MUST parse out as that UUID
        # (matching Module_Files.file_id and Module_File_References).
        uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        result = _parse_s3_key(f"courses/course-1/module-2/{uuid}.pdf")
        assert result["file_id"] == uuid
        assert result["filename"] == f"{uuid}.pdf"
        assert result["course_id"] == "course-1"
        assert result["module_id"] == "module-2"

    def test_invalid_key_missing_prefix(self) -> None:
        with pytest.raises(ValueError, match="does not match expected format"):
            _parse_s3_key("uploads/course-1/module-1/file.pdf")

    def test_invalid_key_too_few_parts(self) -> None:
        with pytest.raises(ValueError, match="does not match expected format"):
            _parse_s3_key("courses/course-1/file.pdf")

    def test_empty_key(self) -> None:
        with pytest.raises(ValueError, match="does not match expected format"):
            _parse_s3_key("")


class TestHandler:
    def test_successful_ingestion(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Happy path: S3 event → parse → persist."""
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"fake pdf content"))
        }
        mock_registry = MagicMock()
        mock_registry.process_file.return_value = [
            RawElement(
                content="Hello world",
                element_type=ElementType.TEXT,
                provenance=Provenance(page_num=1, position_index=0),
            )
        ]
        mock_builder = MagicMock()
        mock_builder.build.return_value = DocumentIR(
            file_metadata=FileMetadata(
                course_id="course-1",
                module_id="module-1",
                file_id="lecture",
                file_key="courses/course-1/module-1/lecture.pdf",
                file_size=1024,
                extension="pdf",
            ),
            elements=[
                IRElement(
                    element_id="abc123",
                    content="Hello world",
                    element_type=ElementType.TEXT,
                    provenance=Provenance(page_num=1, position_index=0),
                    content_hash="def456",
                )
            ],
            element_count={ElementType.TEXT: 1},
            ir_version=IR_VERSION,
        )
        mock_persistence = MagicMock()
        mock_persistence.persist.return_value = (
            "s3://ir-bucket/course-1/module-1/lecture/ir_vir-v1/document_ir.json"
        )

        monkeypatch.setattr(handler_module, "_s3_client", mock_s3)
        monkeypatch.setattr(handler_module, "_registry", mock_registry)
        monkeypatch.setattr(handler_module, "_ir_builder", mock_builder)
        monkeypatch.setattr(handler_module, "_ir_persistence", mock_persistence)

        event = _make_s3_event()
        result = handler(event, _mock_lambda_context())

        assert result["statusCode"] == 200
        assert "results" in result["body"]
        assert result["body"]["results"][0]["statusCode"] == 200
        assert result["body"]["results"][0]["file_id"] == "lecture"
        assert result["body"]["results"][0]["course_id"] == "course-1"
        mock_s3.get_object.assert_called_once_with(
            Bucket="test-bucket", Key="courses/course-1/module-1/lecture.pdf"
        )

    def test_empty_event_returns_400(self) -> None:
        """No records in event should return 400."""
        result = handler({"Records": []}, _mock_lambda_context())
        assert result["statusCode"] == 400

    def test_no_records_key_returns_400(self) -> None:
        """Missing Records key should return 400."""
        result = handler({}, _mock_lambda_context())
        assert result["statusCode"] == 400

    def test_unsupported_format_returns_400(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Unsupported file extension should return 400."""
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"some content"))
        }
        monkeypatch.setattr(handler_module, "_s3_client", mock_s3)

        event = _make_s3_event(key="courses/c1/m1/file.xyz")
        result = handler(event, _mock_lambda_context())

        # Single record failure → all failures → overall gets that status
        assert result["statusCode"] == 400
        assert "Unsupported" in result["body"]["details"][0]["error"]

    def test_invalid_s3_key_format_returns_400(self) -> None:
        """Invalid key format should return 400."""
        event = _make_s3_event(key="invalid/path.pdf")
        result = handler(event, _mock_lambda_context())

        # Single record failure → all failures → overall gets that status
        assert result["statusCode"] == 400

    def test_extraction_failure_returns_500(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ExtractionFailureError should return 500."""
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"corrupted content"))
        }
        mock_registry = MagicMock()
        mock_registry.process_file.side_effect = ExtractionFailureError(
            file_key="courses/c1/m1/bad.pdf", reason="parser crash"
        )
        monkeypatch.setattr(handler_module, "_s3_client", mock_s3)
        monkeypatch.setattr(handler_module, "_registry", mock_registry)

        event = _make_s3_event(key="courses/c1/m1/bad.pdf")
        result = handler(event, _mock_lambda_context())

        assert result["statusCode"] == 500

    def test_file_size_exceeded_returns_400(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """FileSizeExceededError should return 400."""
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"x" * 100))
        }
        mock_registry = MagicMock()
        mock_registry.process_file.side_effect = FileSizeExceededError(
            file_size_bytes=250 * 1024 * 1024, file_key="courses/c1/m1/huge.pdf"
        )
        monkeypatch.setattr(handler_module, "_s3_client", mock_s3)
        monkeypatch.setattr(handler_module, "_registry", mock_registry)

        event = _make_s3_event(key="courses/c1/m1/huge.pdf")
        result = handler(event, _mock_lambda_context())

        assert result["statusCode"] == 400

    def test_url_encoded_key_decoded(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """URL-encoded S3 keys should be decoded properly."""
        mock_s3 = MagicMock()
        mock_s3.get_object.return_value = {
            "Body": MagicMock(read=MagicMock(return_value=b"content"))
        }
        monkeypatch.setattr(handler_module, "_s3_client", mock_s3)

        event = _make_s3_event(key="courses/c1/m1/my+file%20name.pdf")
        result = handler(event, _mock_lambda_context())

        # It should try to download with the decoded key
        mock_s3.get_object.assert_called_once_with(
            Bucket="test-bucket", Key="courses/c1/m1/my file name.pdf"
        )

    def test_missing_bucket_returns_400(self) -> None:
        """Missing bucket name should return 400."""
        event = {
            "Records": [
                {
                    "s3": {
                        "bucket": {"name": ""},
                        "object": {"key": "courses/c1/m1/f.pdf", "size": 100},
                    }
                }
            ]
        }
        result = handler(event, _mock_lambda_context())
        assert result["statusCode"] == 400
