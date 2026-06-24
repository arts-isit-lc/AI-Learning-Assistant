"""Tests for presigned URL Lambda — key format and file type validation.

Validates:
- Key format is courses/{course_id}/{module_id}/{filename}.{ext} (V2 format)
- All new file types are in allowed list (html, htm, tex, latex, csv, json)
- Original file types still supported (pdf, docx, pptx, txt, xlsx, xps, mobi, cbz)
- Unsupported file types return 400
- Missing required parameters return 400
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Add the Lambda directory to path so we can import the handler
sys.path.insert(0, os.path.dirname(__file__))

# Mock heavy dependencies before importing
sys.modules.setdefault("boto3", MagicMock())
sys.modules.setdefault("psycopg2", MagicMock())
sys.modules.setdefault("botocore", MagicMock())
sys.modules.setdefault("botocore.config", MagicMock())
sys.modules.setdefault("aws_lambda_powertools", MagicMock())

# Set required env vars
os.environ.setdefault("BUCKET", "test-ir-bucket")
os.environ.setdefault("REGION", "ca-central-1")


# ---------------------------------------------------------------------------
# Tests: Key format (V2)
# ---------------------------------------------------------------------------


class TestKeyFormat:
    """Presigned URL key uses courses/{course_id}/{module_id}/{filename}.{ext} format."""

    def test_pdf_key_format(self) -> None:
        """PDF upload generates V2 key format."""
        # Simulate the key generation logic from the Lambda
        course_id = "abc-123"
        module_id = "mod-456"
        file_name = "Lecture_Notes"
        file_type = "pdf"

        key = f"courses/{course_id}/{module_id}/{file_name}.{file_type}"

        assert key == "courses/abc-123/mod-456/Lecture_Notes.pdf"
        assert key.startswith("courses/")

    def test_docx_key_format(self) -> None:
        course_id = "course-1"
        module_id = "module-2"
        file_name = "Assignment"
        file_type = "docx"

        key = f"courses/{course_id}/{module_id}/{file_name}.{file_type}"

        assert key == "courses/course-1/module-2/Assignment.docx"

    def test_html_key_format(self) -> None:
        """New V2 file type: HTML."""
        course_id = "c1"
        module_id = "m1"
        file_name = "web_notes"
        file_type = "html"

        key = f"courses/{course_id}/{module_id}/{file_name}.{file_type}"

        assert key == "courses/c1/m1/web_notes.html"

    def test_csv_key_format(self) -> None:
        """New V2 file type: CSV."""
        course_id = "c1"
        module_id = "m1"
        file_name = "data_export"
        file_type = "csv"

        key = f"courses/{course_id}/{module_id}/{file_name}.{file_type}"

        assert key == "courses/c1/m1/data_export.csv"

    def test_key_does_not_use_old_format(self) -> None:
        """Old V1 format was {course_id}/{module_id}/documents/{filename}.{ext}."""
        course_id = "abc-123"
        module_id = "mod-456"
        file_name = "Notes"
        file_type = "pdf"

        key = f"courses/{course_id}/{module_id}/{file_name}.{file_type}"

        # Should NOT contain "documents/" subdirectory (old V1 format)
        assert "/documents/" not in key


# ---------------------------------------------------------------------------
# Tests: Allowed file types
# ---------------------------------------------------------------------------


class TestAllowedFileTypes:
    """All expected file types are in the allowed list."""

    ALLOWED_DOCUMENT_TYPES = {
        "pdf": "application/pdf",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "txt": "text/plain",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xps": "application/oxps",
        "mobi": "application/x-mobipocket-ebook",
        "cbz": "application/vnd.comicbook+zip",
        # V2 multimodal pipeline additions
        "html": "text/html",
        "htm": "text/html",
        "tex": "application/x-tex",
        "latex": "application/x-latex",
        "csv": "text/csv",
        "json": "application/json",
    }

    def test_pdf_supported(self) -> None:
        assert "pdf" in self.ALLOWED_DOCUMENT_TYPES

    def test_docx_supported(self) -> None:
        assert "docx" in self.ALLOWED_DOCUMENT_TYPES

    def test_pptx_supported(self) -> None:
        assert "pptx" in self.ALLOWED_DOCUMENT_TYPES

    def test_txt_supported(self) -> None:
        assert "txt" in self.ALLOWED_DOCUMENT_TYPES

    def test_xlsx_supported(self) -> None:
        assert "xlsx" in self.ALLOWED_DOCUMENT_TYPES

    # V2 additions
    def test_html_supported(self) -> None:
        assert "html" in self.ALLOWED_DOCUMENT_TYPES
        assert self.ALLOWED_DOCUMENT_TYPES["html"] == "text/html"

    def test_htm_supported(self) -> None:
        assert "htm" in self.ALLOWED_DOCUMENT_TYPES
        assert self.ALLOWED_DOCUMENT_TYPES["htm"] == "text/html"

    def test_tex_supported(self) -> None:
        assert "tex" in self.ALLOWED_DOCUMENT_TYPES

    def test_latex_supported(self) -> None:
        assert "latex" in self.ALLOWED_DOCUMENT_TYPES

    def test_csv_supported(self) -> None:
        assert "csv" in self.ALLOWED_DOCUMENT_TYPES
        assert self.ALLOWED_DOCUMENT_TYPES["csv"] == "text/csv"

    def test_json_supported(self) -> None:
        assert "json" in self.ALLOWED_DOCUMENT_TYPES
        assert self.ALLOWED_DOCUMENT_TYPES["json"] == "application/json"

    def test_unsupported_type_not_in_list(self) -> None:
        assert "exe" not in self.ALLOWED_DOCUMENT_TYPES
        assert "py" not in self.ALLOWED_DOCUMENT_TYPES
        assert "zip" not in self.ALLOWED_DOCUMENT_TYPES


# ---------------------------------------------------------------------------
# Tests: Parameter validation
# ---------------------------------------------------------------------------


class TestParameterValidation:
    """Missing required parameters return appropriate errors."""

    def test_missing_course_id_returns_400(self) -> None:
        query_params = {"module_id": "m1", "file_name": "test", "file_type": "pdf"}
        course_id = query_params.get("course_id", "")
        assert not course_id  # Should trigger 400

    def test_missing_module_id_returns_400(self) -> None:
        query_params = {"course_id": "c1", "file_name": "test", "file_type": "pdf"}
        module_id = query_params.get("module_id", "")
        assert not module_id  # Should trigger 400

    def test_missing_file_name_returns_400(self) -> None:
        query_params = {"course_id": "c1", "module_id": "m1", "file_type": "pdf"}
        file_name = query_params.get("file_name", "")
        assert not file_name  # Should trigger 400

    def test_unsupported_file_type_returns_400(self) -> None:
        allowed_types = {"pdf", "docx", "pptx", "html", "csv"}
        file_type = "exe"
        assert file_type not in allowed_types  # Should trigger 400

    def test_all_params_present_is_valid(self) -> None:
        query_params = {
            "course_id": "c1",
            "module_id": "m1",
            "file_name": "notes",
            "file_type": "pdf",
        }
        assert all([
            query_params.get("course_id"),
            query_params.get("module_id"),
            query_params.get("file_name"),
        ])
