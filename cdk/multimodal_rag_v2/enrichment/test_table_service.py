"""Tests for TableService parsing — delimiter detection + honesty guards.

Regression focus (the "1 columns" / shattered-numbers bug): whitespace-aligned
tables extracted from PDFs/PPTX have no pipe/tab/comma delimiter, so they must be
recovered by a 2+-space split rather than collapsed to one CSV cell, and numeric
thousands-separators ("49,995,000") must NOT be shattered. Pipe/TSV/CSV paths and
a genuinely unparseable table (raw preserved, no misleading column count) are also
pinned.
"""

from __future__ import annotations

from ..models.data_models import ElementType, IRElement, Provenance
from .table_service import TableService


def _table_element(content: str) -> IRElement:
    return IRElement(
        element_id="tbl-x",
        content=content,
        element_type=ElementType.TABLE,
        provenance=Provenance(page_num=1, position_index=0),
        content_hash="h",
    )


def _enrich(content: str):
    return TableService().enrich(_table_element(content))


# The Big-O latency table from the reported bad response — whitespace-aligned,
# columns separated by 2+ spaces, values keep single spaces ("0.01 ms").
_BIGO = (
    "Input Size (Logs)   O(1) Hash Map Lookup   O(log n) Tree Search   "
    "O(n) Linear Scan   O(n\u00b2) Nested Comparison\n"
    "100   0.01 ms   0.04 ms   0.15 ms   1.2 ms\n"
    "10,000   0.01 ms   0.08 ms   12 ms   250 ms\n"
    "1,000,000   0.01 ms   0.12 ms   1,150 ms   ~40 minutes\n"
    "10,000,000   0.01 ms   0.15 ms   11,800 ms   ~3 days"
)

# The sort table — whitespace-aligned AND full of comma thousands-separators that
# would shatter under CSV parsing.
_SORT = (
    "Algorithm   Array State   Total Comparisons   Total Swaps   Execution Time\n"
    "Bubble Sort   Randomly Shuffled   49,995,000   ~25,000,000   310 ms\n"
    "Insertion Sort   Nearly Sorted   ~10,000   ~2,500   2 ms"
)


class TestWhitespaceAlignedTables:
    def test_bigo_recovers_five_columns(self):
        e = _enrich(_BIGO)
        assert len(e.table_headers) == 5
        assert e.table_headers[0] == "Input Size (Logs)"
        assert e.table_headers[-1] == "O(n\u00b2) Nested Comparison"

    def test_bigo_rows_preserve_multiword_values(self):
        e = _enrich(_BIGO)
        # Row values with internal single spaces stay intact (not shattered).
        assert e.table_rows[0] == ["100", "0.01 ms", "0.04 ms", "0.15 ms", "1.2 ms"]
        assert e.table_rows[-1] == ["10,000,000", "0.01 ms", "0.15 ms", "11,800 ms", "~3 days"]

    def test_bigo_summary_reports_correct_column_count(self):
        e = _enrich(_BIGO)
        assert "5 columns" in e.table_summary
        # The old bug reported one column for this table.
        assert "1 columns" not in e.table_summary

    def test_bigo_values_present_in_embedding_text(self):
        e = _enrich(_BIGO)
        assert "11,800 ms" in e.embedding_text
        assert "~3 days" in e.embedding_text

    def test_sort_table_thousands_separators_not_shattered(self):
        e = _enrich(_SORT)
        assert len(e.table_headers) == 5
        # The comma-bearing numeric cell must remain a single cell.
        assert e.table_rows[0] == [
            "Bubble Sort", "Randomly Shuffled", "49,995,000", "~25,000,000", "310 ms",
        ]
        assert "5 columns" in e.table_summary


class TestDelimiterRegressions:
    def test_pipe_table_still_parses(self):
        e = _enrich("| Algorithm | Big-O |\n|---|---|\n| Mergesort | n log n |")
        assert e.table_headers == ["Algorithm", "Big-O"]
        assert e.table_rows == [["Mergesort", "n log n"]]

    def test_tsv_table_still_parses(self):
        e = _enrich("Algorithm\tBig-O\nMergesort\tn log n")
        assert e.table_headers == ["Algorithm", "Big-O"]
        assert e.table_rows == [["Mergesort", "n log n"]]

    def test_genuine_csv_still_parses(self):
        # Comma-delimited, no wide spacing -> CSV path (whitespace yields 1 col).
        e = _enrich("Algorithm,Big-O,Note\nMergesort,n log n,stable")
        assert e.table_headers == ["Algorithm", "Big-O", "Note"]
        assert e.table_rows == [["Mergesort", "n log n", "stable"]]

    def test_csv_with_spaces_after_comma_parses(self):
        e = _enrich("a, b, c\n1, 2, 3")
        assert e.table_headers == ["a", "b", "c"]


class TestUnparseableTableHonesty:
    """A single-space-aligned table cannot be reliably split; the service must
    preserve the raw content and NOT assert a misleading column count."""

    _SINGLE_SPACE = (
        "Input Size O(1) O(log n) O(n)\n"
        "100 0.01 0.04 0.15\n"
        "10000 0.01 0.08 12\n"
        "1000000 0.01 0.12 1150\n"
        "10000000 0.01 0.15 11800"
    )

    def test_summary_does_not_claim_one_column(self):
        e = _enrich(self._SINGLE_SPACE)
        assert "1 columns" not in e.table_summary
        assert "could not be reliably parsed" in e.table_summary

    def test_raw_values_preserved_in_embedding_text(self):
        e = _enrich(self._SINGLE_SPACE)
        # No data loss even when structure can't be recovered.
        assert "11800" in e.embedding_text


class TestEmptyTable:
    def test_empty_content(self):
        e = _enrich("   ")
        assert e.table_headers == []
        assert e.table_summary == "Empty table with no data."
