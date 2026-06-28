"""Tests that TABLE retrieval units carry structured headers/rows (Issue #2)."""
from __future__ import annotations

from ..models.data_models import ElementType, EnrichedElement, Provenance
from .retrieval_unit_builder import RetrievalUnitBuilder


def _table_enriched() -> EnrichedElement:
    return EnrichedElement(
        element_id="tbl-1",
        element_type=ElementType.TABLE,
        provenance=Provenance(page_num=4, position_index=0),
        embedding_text="full table text",
        table_headers=["Algorithm", "Big-O"],
        table_rows=[["Mergesort", "n log n"], ["Quicksort", "n^2"]],
        table_summary="Sorting complexity comparison",
        file_id="f1",
        course_id="c1",
        module_id="m1",
    )


class TestTableMetadataStructured:
    def test_metadata_includes_headers_rows_summary(self):
        meta = RetrievalUnitBuilder._build_table_metadata(_table_enriched(), is_summary=True)
        assert meta["content_type"] == "table"
        assert meta["is_table_summary"] is True
        assert meta["table_headers"] == ["Algorithm", "Big-O"]
        assert meta["table_rows"] == [["Mergesort", "n log n"], ["Quicksort", "n^2"]]
        assert meta["table_summary"] == "Sorting complexity comparison"

    def test_column_units_also_carry_structure(self):
        meta = RetrievalUnitBuilder._build_table_metadata(
            _table_enriched(), is_summary=False, column_index=0
        )
        assert meta["table_headers"] == ["Algorithm", "Big-O"]
        assert meta["column_index"] == 0

    def test_rows_capped_at_50(self):
        enriched = _table_enriched()
        enriched.table_rows = [["row", str(i)] for i in range(120)]
        meta = RetrievalUnitBuilder._build_table_metadata(enriched, is_summary=True)
        assert len(meta["table_rows"]) == 50
