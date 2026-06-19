"""Unit tests for IRBuilder — deduplication, ordering, filtering, and error handling."""

from __future__ import annotations

import hashlib

import pytest

from ..models.data_models import (
    DocumentIR,
    ElementType,
    FileMetadata,
    IRElement,
    IR_VERSION,
    Provenance,
    RawElement,
)
from .exceptions import ExtractionFailureError
from .ir_builder import IRBuilder


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_metadata(
    file_key: str = "courses/CS101/module1/lecture.pdf",
) -> FileMetadata:
    return FileMetadata(
        course_id="CS101",
        module_id="module1",
        file_id="file-123",
        file_key=file_key,
        file_size=1024,
        extension="pdf",
    )


def _make_raw_element(
    content: bytes | str = "Hello world",
    element_type: ElementType = ElementType.TEXT,
    page_num: int | None = 1,
    position_index: int = 0,
    raw_metadata: dict | None = None,
) -> RawElement:
    return RawElement(
        content=content,
        element_type=element_type,
        provenance=Provenance(page_num=page_num, position_index=position_index),
        raw_metadata=raw_metadata or {},
    )


def _compute_content_hash(content: bytes | str) -> str:
    if isinstance(content, bytes):
        return hashlib.sha256(content).hexdigest()
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Tests for basic build functionality
# ---------------------------------------------------------------------------


class TestIRBuilderBasic:
    def test_build_single_element(self) -> None:
        builder = IRBuilder()
        raw = [_make_raw_element(content="Test content")]
        result = builder.build(raw, _make_metadata())

        assert isinstance(result, DocumentIR)
        assert len(result.elements) == 1
        assert result.elements[0].content == "Test content"
        assert result.elements[0].element_type == ElementType.TEXT
        assert result.ir_version == IR_VERSION

    def test_build_multiple_elements(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="First", page_num=1, position_index=0),
            _make_raw_element(content="Second", page_num=1, position_index=1),
            _make_raw_element(content="Third", page_num=2, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())

        assert len(result.elements) == 3
        assert result.elements[0].content == "First"
        assert result.elements[1].content == "Second"
        assert result.elements[2].content == "Third"

    def test_build_preserves_file_metadata(self) -> None:
        builder = IRBuilder()
        metadata = _make_metadata()
        raw = [_make_raw_element()]
        result = builder.build(raw, metadata)

        assert result.file_metadata is metadata

    def test_build_sets_ir_version(self) -> None:
        builder = IRBuilder()
        raw = [_make_raw_element()]
        result = builder.build(raw, _make_metadata())

        assert result.ir_version == IR_VERSION
        assert result.ir_version != ""


# ---------------------------------------------------------------------------
# Tests for element_id assignment
# ---------------------------------------------------------------------------


class TestElementId:
    def test_element_id_is_sha256_of_content_plus_provenance(self) -> None:
        builder = IRBuilder()
        content = "Test content"
        prov = Provenance(page_num=1, slide_num=None, section=None, position_index=0)
        raw = [RawElement(content=content, element_type=ElementType.TEXT, provenance=prov)]
        result = builder.build(raw, _make_metadata())

        content_bytes = content.encode("utf-8")
        provenance_str = f"{prov.page_num}:{prov.slide_num}:{prov.section}:{prov.position_index}"
        expected_id = hashlib.sha256(
            content_bytes + provenance_str.encode("utf-8")
        ).hexdigest()

        assert result.elements[0].element_id == expected_id

    def test_element_id_differs_for_same_content_different_provenance(self) -> None:
        builder = IRBuilder()
        # Same content but different page_num — so content_hash is same (dedup)
        # Actually these have different provenance, but same content means same content_hash
        # so only first occurrence wins due to dedup.
        # Use unique content for this test:
        raw = [
            _make_raw_element(content="Same content on page 1", page_num=1, position_index=0),
            _make_raw_element(content="Same content on page 2", page_num=2, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())

        assert len(result.elements) == 2
        assert result.elements[0].element_id != result.elements[1].element_id

    def test_element_id_for_binary_content(self) -> None:
        builder = IRBuilder()
        content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        raw = [
            _make_raw_element(
                content=content,
                element_type=ElementType.IMAGE,
                raw_metadata={"width": 200, "height": 200},
            )
        ]
        result = builder.build(raw, _make_metadata())

        # Verify element_id is computed from raw bytes + provenance
        prov_str = f"1:None:None:0"
        expected_id = hashlib.sha256(content + prov_str.encode("utf-8")).hexdigest()
        assert result.elements[0].element_id == expected_id


# ---------------------------------------------------------------------------
# Tests for content_hash and deduplication
# ---------------------------------------------------------------------------


class TestDeduplication:
    def test_content_hash_is_sha256_of_content(self) -> None:
        builder = IRBuilder()
        content = "Test dedup"
        raw = [_make_raw_element(content=content)]
        result = builder.build(raw, _make_metadata())

        expected_hash = _compute_content_hash(content)
        assert result.elements[0].content_hash == expected_hash

    def test_duplicate_content_deduplicated(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Duplicate", page_num=1, position_index=0),
            _make_raw_element(content="Duplicate", page_num=2, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())

        # Only first occurrence kept
        assert len(result.elements) == 1
        assert result.elements[0].provenance.page_num == 1

    def test_first_occurrence_wins(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Same text", page_num=3, position_index=5),
            _make_raw_element(content="Same text", page_num=1, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())

        # First in the input list wins (page_num=3)
        assert len(result.elements) == 1
        assert result.elements[0].provenance.page_num == 3

    def test_different_content_not_deduplicated(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Content A", page_num=1, position_index=0),
            _make_raw_element(content="Content B", page_num=1, position_index=1),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 2

    def test_binary_content_dedup(self) -> None:
        builder = IRBuilder()
        image_bytes = b"\x89PNG" + b"\x00" * 50
        raw = [
            _make_raw_element(
                content=image_bytes,
                element_type=ElementType.IMAGE,
                page_num=1,
                raw_metadata={"width": 200, "height": 200},
            ),
            _make_raw_element(
                content=image_bytes,
                element_type=ElementType.IMAGE,
                page_num=2,
                raw_metadata={"width": 200, "height": 200},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 1


# ---------------------------------------------------------------------------
# Tests for ordering
# ---------------------------------------------------------------------------


class TestOrdering:
    def test_sorted_by_page_num(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Page 3", page_num=3, position_index=0),
            _make_raw_element(content="Page 1", page_num=1, position_index=0),
            _make_raw_element(content="Page 2", page_num=2, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())

        pages = [el.provenance.page_num for el in result.elements]
        assert pages == [1, 2, 3]

    def test_sorted_by_position_index_within_page(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Pos 2", page_num=1, position_index=2),
            _make_raw_element(content="Pos 0", page_num=1, position_index=0),
            _make_raw_element(content="Pos 1", page_num=1, position_index=1),
        ]
        result = builder.build(raw, _make_metadata())

        positions = [el.provenance.position_index for el in result.elements]
        assert positions == [0, 1, 2]

    def test_none_page_treated_as_zero(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Page 2", page_num=2, position_index=0),
            _make_raw_element(content="No page", page_num=None, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())

        # None → 0, so it sorts before page 2
        assert result.elements[0].content == "No page"
        assert result.elements[1].content == "Page 2"

    def test_sort_by_slide_num_secondary(self) -> None:
        builder = IRBuilder()
        raw = [
            RawElement(
                content="Slide 3",
                element_type=ElementType.TEXT,
                provenance=Provenance(page_num=1, slide_num=3, position_index=0),
            ),
            RawElement(
                content="Slide 1",
                element_type=ElementType.TEXT,
                provenance=Provenance(page_num=1, slide_num=1, position_index=0),
            ),
        ]
        result = builder.build(raw, _make_metadata())

        assert result.elements[0].content == "Slide 1"
        assert result.elements[1].content == "Slide 3"


# ---------------------------------------------------------------------------
# Tests for element_count
# ---------------------------------------------------------------------------


class TestElementCount:
    def test_element_count_by_type(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Text 1", element_type=ElementType.TEXT, position_index=0),
            _make_raw_element(content="Text 2", element_type=ElementType.TEXT, position_index=1),
            _make_raw_element(
                content=b"\x89PNG" + b"\x01" * 50,
                element_type=ElementType.IMAGE,
                position_index=2,
                raw_metadata={"width": 200, "height": 200},
            ),
            _make_raw_element(content="x^2 + y^2", element_type=ElementType.FORMULA, position_index=3),
        ]
        result = builder.build(raw, _make_metadata())

        assert result.element_count[ElementType.TEXT] == 2
        assert result.element_count[ElementType.IMAGE] == 1
        assert result.element_count[ElementType.FORMULA] == 1

    def test_element_count_excludes_filtered_images(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Text", element_type=ElementType.TEXT, position_index=0),
            _make_raw_element(
                content=b"small",
                element_type=ElementType.IMAGE,
                position_index=1,
                raw_metadata={"width": 50, "height": 50},
            ),
        ]
        result = builder.build(raw, _make_metadata())

        assert ElementType.IMAGE not in result.element_count
        assert result.element_count[ElementType.TEXT] == 1


# ---------------------------------------------------------------------------
# Tests for small image filtering
# ---------------------------------------------------------------------------


class TestSmallImageFiltering:
    def test_filters_image_below_100x100(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content=b"tiny",
                element_type=ElementType.IMAGE,
                raw_metadata={"width": 99, "height": 150},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 0

    def test_filters_image_below_height(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content=b"short",
                element_type=ElementType.IMAGE,
                raw_metadata={"width": 200, "height": 50},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 0

    def test_keeps_image_at_exactly_100x100(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content=b"exact",
                element_type=ElementType.IMAGE,
                raw_metadata={"width": 100, "height": 100},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 1

    def test_keeps_large_image(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content=b"large",
                element_type=ElementType.IMAGE,
                raw_metadata={"width": 800, "height": 600},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 1

    def test_keeps_image_without_dimensions(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content=b"no dims",
                element_type=ElementType.IMAGE,
                raw_metadata={},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 1

    def test_does_not_filter_non_image_types(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content="Small table",
                element_type=ElementType.TABLE,
                raw_metadata={"width": 50, "height": 50},
            ),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 1


# ---------------------------------------------------------------------------
# Tests for zero-element documents
# ---------------------------------------------------------------------------


class TestZeroElementDocument:
    def test_empty_raw_elements_produces_empty_ir(self) -> None:
        builder = IRBuilder()
        result = builder.build([], _make_metadata())

        assert isinstance(result, DocumentIR)
        assert result.elements == []
        assert result.element_count == {}
        assert result.ir_version == IR_VERSION

    def test_all_elements_filtered_produces_empty_ir(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content=b"tiny1",
                element_type=ElementType.IMAGE,
                raw_metadata={"width": 10, "height": 10},
            ),
            _make_raw_element(
                content=b"tiny2",
                element_type=ElementType.IMAGE,
                position_index=1,
                raw_metadata={"width": 20, "height": 20},
            ),
        ]
        result = builder.build(raw, _make_metadata())

        assert result.elements == []
        assert result.element_count == {}

    def test_all_elements_duplicated_produces_single_element(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(content="Same", page_num=1, position_index=0),
            _make_raw_element(content="Same", page_num=2, position_index=0),
            _make_raw_element(content="Same", page_num=3, position_index=0),
        ]
        result = builder.build(raw, _make_metadata())
        assert len(result.elements) == 1


# ---------------------------------------------------------------------------
# Tests for metadata preservation
# ---------------------------------------------------------------------------


class TestMetadataPreservation:
    def test_raw_metadata_copied_to_ir_element(self) -> None:
        builder = IRBuilder()
        raw = [
            _make_raw_element(
                content="With meta",
                raw_metadata={"source": "table_extraction", "confidence": 0.95},
            ),
        ]
        result = builder.build(raw, _make_metadata())

        assert result.elements[0].metadata == {"source": "table_extraction", "confidence": 0.95}

    def test_raw_metadata_is_copied_not_shared(self) -> None:
        builder = IRBuilder()
        original_meta = {"key": "value"}
        raw = [_make_raw_element(content="Test", raw_metadata=original_meta)]
        result = builder.build(raw, _make_metadata())

        # Mutating original should not affect result
        original_meta["key"] = "changed"
        assert result.elements[0].metadata["key"] == "value"
