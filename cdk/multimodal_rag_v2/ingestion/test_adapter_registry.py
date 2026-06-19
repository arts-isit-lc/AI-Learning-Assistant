"""Unit tests for AdapterRegistry — extension routing, file size validation, and process_file."""

from __future__ import annotations

import pytest

from ..models.data_models import FileMetadata, Provenance, RawElement, ElementType
from .adapter_registry import AdapterRegistry, MAX_FILE_SIZE_BYTES
from .base_adapter import BaseAdapter
from .exceptions import FileSizeExceededError, UnsupportedFormatError


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


class FakeAdapter(BaseAdapter):
    """A minimal adapter for testing that returns a single TEXT element."""

    def extract(self, file_content: bytes, file_metadata: FileMetadata) -> list[RawElement]:
        return [
            RawElement(
                content="extracted text",
                element_type=ElementType.TEXT,
                provenance=Provenance(page_num=1, position_index=0),
            )
        ]


def _make_metadata(
    file_key: str = "courses/CS101/module1/lecture.pdf",
    file_size: int = 1024,
    extension: str = "pdf",
) -> FileMetadata:
    return FileMetadata(
        course_id="CS101",
        module_id="module1",
        file_id="file-123",
        file_key=file_key,
        file_size=file_size,
        extension=extension,
    )


# ---------------------------------------------------------------------------
# Tests for register()
# ---------------------------------------------------------------------------


class TestAdapterRegistration:
    def test_register_single_extension(self) -> None:
        registry = AdapterRegistry()
        adapter = FakeAdapter()
        registry.register(["pdf"], adapter)
        assert registry.get_adapter("document.pdf") is adapter

    def test_register_multiple_extensions(self) -> None:
        registry = AdapterRegistry()
        adapter = FakeAdapter()
        registry.register(["png", "jpg", "jpeg"], adapter)
        assert registry.get_adapter("image.png") is adapter
        assert registry.get_adapter("photo.jpg") is adapter
        assert registry.get_adapter("photo.jpeg") is adapter

    def test_register_case_insensitive(self) -> None:
        registry = AdapterRegistry()
        adapter = FakeAdapter()
        registry.register(["PDF"], adapter)
        assert registry.get_adapter("document.pdf") is adapter
        assert registry.get_adapter("document.PDF") is adapter

    def test_register_overwrites_previous(self) -> None:
        registry = AdapterRegistry()
        adapter1 = FakeAdapter()
        adapter2 = FakeAdapter()
        registry.register(["pdf"], adapter1)
        registry.register(["pdf"], adapter2)
        assert registry.get_adapter("doc.pdf") is adapter2


# ---------------------------------------------------------------------------
# Tests for get_adapter()
# ---------------------------------------------------------------------------


class TestGetAdapter:
    def test_supported_extension_returns_adapter(self) -> None:
        registry = AdapterRegistry()
        adapter = FakeAdapter()
        registry.register(["docx"], adapter)
        assert registry.get_adapter("courses/CS101/notes.docx") is adapter

    def test_unsupported_extension_raises(self) -> None:
        registry = AdapterRegistry()
        registry.register(["pdf"], FakeAdapter())
        with pytest.raises(UnsupportedFormatError) as exc_info:
            registry.get_adapter("file.xyz")
        assert exc_info.value.extension == "xyz"
        assert "file.xyz" in exc_info.value.file_key

    def test_missing_extension_raises(self) -> None:
        registry = AdapterRegistry()
        registry.register(["pdf"], FakeAdapter())
        with pytest.raises(UnsupportedFormatError) as exc_info:
            registry.get_adapter("no_extension_file")
        assert exc_info.value.extension == ""

    def test_extension_extraction_from_s3_key(self) -> None:
        registry = AdapterRegistry()
        adapter = FakeAdapter()
        registry.register(["pptx"], adapter)
        result = registry.get_adapter("courses/CS101/module2/slides.pptx")
        assert result is adapter

    def test_extension_with_dots_in_path(self) -> None:
        registry = AdapterRegistry()
        adapter = FakeAdapter()
        registry.register(["pdf"], adapter)
        # File key has dots in directory names but the extension is still .pdf
        result = registry.get_adapter("courses/v2.0/module.1/doc.pdf")
        assert result is adapter


# ---------------------------------------------------------------------------
# Tests for validate_file_size()
# ---------------------------------------------------------------------------


class TestFileSizeValidation:
    def test_file_within_limit_passes(self) -> None:
        registry = AdapterRegistry()
        content = b"x" * 1024  # 1 KB
        metadata = _make_metadata(file_size=1024)
        # Should not raise
        registry.validate_file_size(content, metadata)

    def test_file_at_exact_limit_passes(self) -> None:
        registry = AdapterRegistry()
        content = b"x" * 100  # content smaller, metadata has exact limit
        metadata = _make_metadata(file_size=MAX_FILE_SIZE_BYTES)
        # Exactly at limit — should pass
        registry.validate_file_size(content, metadata)

    def test_file_exceeds_limit_raises(self) -> None:
        registry = AdapterRegistry()
        oversized = MAX_FILE_SIZE_BYTES + 1
        content = b"x" * 100  # content is small but metadata reports large
        metadata = _make_metadata(file_size=oversized)
        with pytest.raises(FileSizeExceededError) as exc_info:
            registry.validate_file_size(content, metadata)
        assert exc_info.value.file_size_bytes == oversized

    def test_file_size_uses_content_length_when_metadata_is_zero(self) -> None:
        registry = AdapterRegistry()
        # file_size=0 means metadata unavailable, fallback to len(content)
        content = b"x" * (MAX_FILE_SIZE_BYTES + 1)
        metadata = _make_metadata(file_size=0)
        with pytest.raises(FileSizeExceededError):
            registry.validate_file_size(content, metadata)

    def test_small_content_with_zero_metadata_passes(self) -> None:
        registry = AdapterRegistry()
        content = b"small file"
        metadata = _make_metadata(file_size=0)
        # file_size=0, fallback to len(content) which is small
        registry.validate_file_size(content, metadata)


# ---------------------------------------------------------------------------
# Tests for process_file()
# ---------------------------------------------------------------------------


class TestProcessFile:
    def test_process_file_happy_path(self) -> None:
        registry = AdapterRegistry()
        registry.register(["pdf"], FakeAdapter())
        content = b"PDF content"
        metadata = _make_metadata(file_size=len(content))
        result = registry.process_file(content, metadata)
        assert len(result) == 1
        assert result[0].element_type == ElementType.TEXT

    def test_process_file_rejects_oversized_before_extraction(self) -> None:
        """Ensure size check happens BEFORE adapter extraction."""
        registry = AdapterRegistry()

        class TrackingAdapter(BaseAdapter):
            called = False

            def extract(self, file_content: bytes, file_metadata: FileMetadata) -> list[RawElement]:
                TrackingAdapter.called = True
                return []

        registry.register(["pdf"], TrackingAdapter())
        content = b"x" * 100
        metadata = _make_metadata(file_size=MAX_FILE_SIZE_BYTES + 1)

        with pytest.raises(FileSizeExceededError):
            registry.process_file(content, metadata)

        # Adapter should NOT have been called
        assert not TrackingAdapter.called

    def test_process_file_rejects_unsupported_format(self) -> None:
        registry = AdapterRegistry()
        registry.register(["pdf"], FakeAdapter())
        content = b"content"
        metadata = _make_metadata(
            file_key="file.unsupported", file_size=100, extension="unsupported"
        )
        with pytest.raises(UnsupportedFormatError):
            registry.process_file(content, metadata)

    def test_process_file_size_check_precedes_format_check(self) -> None:
        """File size is validated first, even if format is unsupported."""
        registry = AdapterRegistry()
        registry.register(["pdf"], FakeAdapter())
        content = b"x" * 100
        metadata = _make_metadata(
            file_key="huge.xyz",
            file_size=MAX_FILE_SIZE_BYTES + 1,
            extension="xyz",
        )
        # Should raise FileSizeExceededError, not UnsupportedFormatError
        with pytest.raises(FileSizeExceededError):
            registry.process_file(content, metadata)
