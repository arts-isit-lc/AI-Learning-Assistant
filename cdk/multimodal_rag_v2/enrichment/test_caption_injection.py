"""Tests for caption injection — prepends figure/table captions into TABLE/IMAGE units.

Validates that _inject_captions_into_elements:
- Prepends table captions to TABLE units on the same page
- Prepends figure captions to IMAGE units on the same page
- Does not inject when elements are on different pages
- Does not duplicate captions already present
- Works when file_id is empty (the bug fixed during switchover)
- Does not inject into unrelated element types
"""

from __future__ import annotations

import pytest

from ..models.data_models import (
    EMBEDDING_VERSION,
    ElementType,
    EnrichedElement,
    Provenance,
    RetrievalUnit,
)
from .retrieval_unit_builder import RetrievalUnitBuilder


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_text_enriched(
    element_id: str = "text-1",
    embedding_text: str = "Some body text.",
    page_num: int = 1,
    file_id: str = "",
) -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=page_num, position_index=0),
        embedding_text=embedding_text,
        file_id=file_id,
        course_id="course-1",
        module_id="module-1",
    )


def _make_table_unit(
    retrieval_id: str = "table-unit-1",
    embedding_text: str = "Input Size: 100, 200, 500",
    page_num: int = 4,
    file_id: str = "",
) -> RetrievalUnit:
    return RetrievalUnit(
        retrieval_id=retrieval_id,
        parent_element_id="table-parent-1",
        embedding_text=embedding_text,
        element_type=ElementType.TABLE,
        provenance=Provenance(page_num=page_num, position_index=1),
        metadata={"content_type": "table", "file_id": file_id, "provenance_page_num": page_num},
        sibling_ids=[],
        embedding_version=EMBEDDING_VERSION,
    )


def _make_image_unit(
    retrieval_id: str = "image-unit-1",
    embedding_text: str = "A page showing algorithmic content.",
    page_num: int = 3,
    file_id: str = "",
) -> RetrievalUnit:
    return RetrievalUnit(
        retrieval_id=retrieval_id,
        parent_element_id="image-parent-1",
        embedding_text=embedding_text,
        element_type=ElementType.IMAGE,
        provenance=Provenance(page_num=page_num, position_index=2),
        metadata={"content_type": "image", "file_id": file_id, "provenance_page_num": page_num},
        sibling_ids=[],
        embedding_version=EMBEDDING_VERSION,
    )


def _make_text_unit(
    retrieval_id: str = "text-unit-1",
    embedding_text: str = "Regular body text content.",
    page_num: int = 4,
) -> RetrievalUnit:
    return RetrievalUnit(
        retrieval_id=retrieval_id,
        parent_element_id="text-parent-1",
        embedding_text=embedding_text,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=page_num, position_index=0),
        metadata={"content_type": "text"},
        sibling_ids=[],
        embedding_version=EMBEDDING_VERSION,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestCaptionInjectionIntoTables:
    """Table captions are prepended to TABLE units on the same page."""

    def test_table_caption_prepended_to_table_unit(self) -> None:
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                element_id="caption-text",
                embedding_text="Table 1.1: Measured algorithm latency across scaling datasets.",
                page_num=4,
            ),
        ]
        units = [_make_table_unit(page_num=4)]

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text.startswith("Table 1.1: Measured algorithm latency")
        assert "Input Size: 100, 200, 500" in units[0].embedding_text

    def test_table_caption_not_injected_when_different_page(self) -> None:
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Table 1.1: Some table.",
                page_num=4,
            ),
        ]
        units = [_make_table_unit(page_num=7)]  # Different page

        builder._inject_captions_into_elements(units, enriched)

        assert not units[0].embedding_text.startswith("Table 1.1")

    def test_no_duplication_if_caption_already_present(self) -> None:
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Table 1.1: Latency data.",
                page_num=4,
            ),
        ]
        # Table unit already contains the caption text
        units = [_make_table_unit(
            embedding_text="Table 1.1: Latency data.\nInput Size: 100, 200",
            page_num=4,
        )]

        builder._inject_captions_into_elements(units, enriched)

        # Should not prepend again
        assert units[0].embedding_text.count("Table 1.1") == 1

    def test_works_with_empty_file_id(self) -> None:
        """The bug fix: file_id="" should not prevent injection."""
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Table 2.1: Sorting times.",
                page_num=5,
                file_id="",  # Empty file_id
            ),
        ]
        units = [_make_table_unit(page_num=5, file_id="")]

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text.startswith("Table 2.1: Sorting times")


class TestCaptionInjectionIntoImages:
    """Figure captions are prepended to IMAGE units on the same page."""

    def test_figure_caption_prepended_to_image_unit(self) -> None:
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Figure 1.1: Common Big-O Time Complexities.",
                page_num=3,
            ),
        ]
        units = [_make_image_unit(page_num=3)]

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text.startswith("Figure 1.1: Common Big-O")

    def test_fig_abbreviation_works(self) -> None:
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Fig. 3.2: Network topology diagram.",
                page_num=6,
            ),
        ]
        units = [_make_image_unit(page_num=6)]

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text.startswith("Fig. 3.2")

    def test_figure_caption_not_injected_into_table_unit(self) -> None:
        """Figure captions only go to IMAGE units, not TABLE units."""
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Figure 2.1: Binary search visualization.",
                page_num=5,
            ),
        ]
        units = [_make_table_unit(page_num=5)]

        builder._inject_captions_into_elements(units, enriched)

        assert not units[0].embedding_text.startswith("Figure 2.1")


class TestCaptionInjectionNoMatch:
    """No injection when captions don't match."""

    def test_no_injection_when_no_captions_exist(self) -> None:
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(embedding_text="Regular paragraph text.", page_num=4),
        ]
        units = [_make_table_unit(page_num=4)]
        original_text = units[0].embedding_text

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text == original_text

    def test_no_injection_when_caption_beyond_150_chars(self) -> None:
        """Caption pattern must appear within first 150 chars."""
        builder = RetrievalUnitBuilder()
        # Caption appears after 150 chars
        padding = "x" * 160
        enriched = [
            _make_text_enriched(
                embedding_text=f"{padding} Table 3.1: Late caption.",
                page_num=4,
            ),
        ]
        units = [_make_table_unit(page_num=4)]
        original_text = units[0].embedding_text

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text == original_text

    def test_text_units_are_not_modified(self) -> None:
        """Only TABLE and IMAGE units get captions injected."""
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_text_enriched(
                embedding_text="Table 1.1: Something.",
                page_num=4,
            ),
        ]
        text_unit = _make_text_unit(page_num=4)
        original_text = text_unit.embedding_text

        builder._inject_captions_into_elements([text_unit], enriched)

        assert text_unit.embedding_text == original_text

    def test_none_page_num_skipped(self) -> None:
        """Elements with page_num=None are skipped."""
        builder = RetrievalUnitBuilder()
        enriched = [
            EnrichedElement(
                element_id="no-page",
                element_type=ElementType.TEXT,
                provenance=Provenance(page_num=None, position_index=0),
                embedding_text="Table 1.1: No page.",
                file_id="",
                course_id="",
                module_id="",
            ),
        ]
        units = [_make_table_unit(page_num=4)]
        original_text = units[0].embedding_text

        builder._inject_captions_into_elements(units, enriched)

        assert units[0].embedding_text == original_text
