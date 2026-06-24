"""Tests for caption-element sibling linking — bidirectional links between captions and visual/data elements.

Validates that _link_captions_to_page_images:
- Creates bidirectional sibling_ids between figure captions and IMAGE units on same page
- Creates bidirectional sibling_ids between table captions and TABLE+IMAGE units on same page
- Sets figure_ref metadata on caption TEXT units
- Does not link when elements are on different pages
- Does not link when no captions exist
- Works when file_id is empty (single-file processing)
"""

from __future__ import annotations

import pytest

from ..models.data_models import (
    EMBEDDING_VERSION,
    ElementType,
    Provenance,
    RetrievalUnit,
)
from .retrieval_unit_builder import RetrievalUnitBuilder


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_unit(
    retrieval_id: str,
    element_type: ElementType,
    embedding_text: str,
    page_num: int,
    file_id: str = "",
) -> RetrievalUnit:
    metadata = {
        "content_type": element_type.value,
        "file_id": file_id,
        "provenance_page_num": page_num,
        "provenance_position_index": 0,
    }
    if element_type == ElementType.IMAGE:
        metadata["image_s3_key"] = f"s3://bucket/images/{retrieval_id}.png"
    return RetrievalUnit(
        retrieval_id=retrieval_id,
        parent_element_id=f"parent-{retrieval_id}",
        embedding_text=embedding_text,
        element_type=element_type,
        provenance=Provenance(page_num=page_num, position_index=0),
        metadata=metadata,
        sibling_ids=[],
        embedding_version=EMBEDDING_VERSION,
    )


# ---------------------------------------------------------------------------
# Tests: Figure caption → IMAGE linking
# ---------------------------------------------------------------------------


class TestFigureCaptionToImageLinking:
    """Figure captions link to IMAGE elements on the same page."""

    def test_figure_caption_links_to_image_on_same_page(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: Big-O complexities.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "A rendered page.", page_num=3)
        units = [caption, image]

        builder._link_captions_to_page_images(units)

        assert "img-1" in caption.sibling_ids
        assert "text-1" in image.sibling_ids

    def test_fig_abbreviation_links_to_image(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Fig. 2.3: Network diagram.", page_num=5)
        image = _make_unit("img-1", ElementType.IMAGE, "Page render.", page_num=5)
        units = [caption, image]

        builder._link_captions_to_page_images(units)

        assert "img-1" in caption.sibling_ids
        assert "text-1" in image.sibling_ids

    def test_figure_caption_does_not_link_to_image_on_different_page(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: Graph.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "Page render.", page_num=7)
        units = [caption, image]

        builder._link_captions_to_page_images(units)

        assert caption.sibling_ids == []
        assert image.sibling_ids == []

    def test_multiple_figures_on_same_page_all_link_to_same_image(self) -> None:
        builder = RetrievalUnitBuilder()
        caption1 = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: First chart.", page_num=3)
        caption2 = _make_unit("text-2", ElementType.TEXT, "Figure 1.2: Second chart.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "Page render.", page_num=3)
        units = [caption1, caption2, image]

        builder._link_captions_to_page_images(units)

        assert "img-1" in caption1.sibling_ids
        assert "img-1" in caption2.sibling_ids
        assert "text-1" in image.sibling_ids
        assert "text-2" in image.sibling_ids


# ---------------------------------------------------------------------------
# Tests: Table caption → TABLE + IMAGE linking
# ---------------------------------------------------------------------------


class TestTableCaptionLinking:
    """Table captions link to TABLE elements AND IMAGE elements on same page."""

    def test_table_caption_links_to_table_unit(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Table 1.1: Latency data.", page_num=4)
        table = _make_unit("tbl-1", ElementType.TABLE, "Input: 100, 200, 500", page_num=4)
        units = [caption, table]

        builder._link_captions_to_page_images(units)

        assert "tbl-1" in caption.sibling_ids
        assert "text-1" in table.sibling_ids

    def test_table_caption_also_links_to_image_on_same_page(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Table 2.1: Sorting times.", page_num=5)
        table = _make_unit("tbl-1", ElementType.TABLE, "Merge: 12ms, Quick: 8ms", page_num=5)
        image = _make_unit("img-1", ElementType.IMAGE, "Page render.", page_num=5)
        units = [caption, table, image]

        builder._link_captions_to_page_images(units)

        # Caption links to both table and image
        assert "tbl-1" in caption.sibling_ids
        assert "img-1" in caption.sibling_ids
        # Both link back to caption
        assert "text-1" in table.sibling_ids
        assert "text-1" in image.sibling_ids

    def test_table_caption_does_not_link_across_pages(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Table 3.1: Data.", page_num=6)
        table = _make_unit("tbl-1", ElementType.TABLE, "Row data.", page_num=9)
        units = [caption, table]

        builder._link_captions_to_page_images(units)

        assert caption.sibling_ids == []
        assert table.sibling_ids == []


# ---------------------------------------------------------------------------
# Tests: figure_ref metadata
# ---------------------------------------------------------------------------


class TestFigureRefMetadata:
    """Caption linking sets figure_ref in metadata."""

    def test_figure_ref_set_for_figure_caption(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: Chart.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "Render.", page_num=3)
        units = [caption, image]

        builder._link_captions_to_page_images(units)

        assert caption.metadata.get("figure_ref") == "figure 1.1"

    def test_figure_ref_set_for_table_caption(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Table 4.2: Results.", page_num=8)
        table = _make_unit("tbl-1", ElementType.TABLE, "Data.", page_num=8)
        units = [caption, table]

        builder._link_captions_to_page_images(units)

        assert caption.metadata.get("figure_ref") == "table 4.2"

    def test_figure_ref_not_set_on_non_caption_text(self) -> None:
        builder = RetrievalUnitBuilder()
        body_text = _make_unit("text-1", ElementType.TEXT, "Regular paragraph.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "Render.", page_num=3)
        units = [body_text, image]

        builder._link_captions_to_page_images(units)

        assert "figure_ref" not in body_text.metadata


# ---------------------------------------------------------------------------
# Tests: No linking cases
# ---------------------------------------------------------------------------


class TestNoLinking:
    """Cases where no linking should occur."""

    def test_no_linking_when_no_images_or_tables(self) -> None:
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: Chart.", page_num=3)
        body = _make_unit("text-2", ElementType.TEXT, "Body text.", page_num=3)
        units = [caption, body]

        builder._link_captions_to_page_images(units)

        assert caption.sibling_ids == []
        assert body.sibling_ids == []

    def test_no_linking_when_no_caption_text(self) -> None:
        builder = RetrievalUnitBuilder()
        body = _make_unit("text-1", ElementType.TEXT, "Just regular content.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "Render.", page_num=3)
        units = [body, image]

        builder._link_captions_to_page_images(units)

        assert body.sibling_ids == []
        assert image.sibling_ids == []

    def test_empty_unit_list(self) -> None:
        builder = RetrievalUnitBuilder()
        units: list[RetrievalUnit] = []

        builder._link_captions_to_page_images(units)  # Should not raise

    def test_works_with_none_page_num(self) -> None:
        """Units with page_num=None are skipped without error."""
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: Chart.", page_num=3)
        caption.provenance = Provenance(page_num=None, position_index=0)
        image = _make_unit("img-1", ElementType.IMAGE, "Render.", page_num=3)
        units = [caption, image]

        builder._link_captions_to_page_images(units)

        # Caption has no page, so no linking
        assert caption.sibling_ids == []
        assert image.sibling_ids == []

    def test_no_duplicate_sibling_ids_on_repeated_calls(self) -> None:
        """Calling linking twice doesn't create duplicate sibling entries."""
        builder = RetrievalUnitBuilder()
        caption = _make_unit("text-1", ElementType.TEXT, "Figure 1.1: Chart.", page_num=3)
        image = _make_unit("img-1", ElementType.IMAGE, "Render.", page_num=3)
        units = [caption, image]

        builder._link_captions_to_page_images(units)
        builder._link_captions_to_page_images(units)

        assert caption.sibling_ids.count("img-1") == 1
        assert image.sibling_ids.count("text-1") == 1
