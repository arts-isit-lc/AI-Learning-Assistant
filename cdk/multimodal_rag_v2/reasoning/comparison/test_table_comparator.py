"""Tests for TableComparator (pure, N-way-ready)."""

from __future__ import annotations

from ...models.data_models import ResolutionConfidence, ResolvedReferent
from .table_comparator import TableComparator


def _ref(label, headers, rows) -> ResolvedReferent:
    return ResolvedReferent(
        reference=label,
        retrieval_id=label,
        parent_element_id=label,
        confidence=ResolutionConfidence.HIGH,
        structured_content={"headers": headers, "rows": rows},
    )


def test_shared_and_unique_columns_two_tables() -> None:
    a = _ref("Table 2.1", ["id", "name", "score"], [["1", "a", "10"]])
    b = _ref("Table 3.1", ["id", "name", "region"], [["1", "a", "west"]])
    facts = TableComparator().compare([a, b])
    assert facts.shared_columns == ["id", "name"]
    assert facts.unique_columns == {"Table 2.1": ["score"], "Table 3.1": ["region"]}
    assert [s.label for s in facts.per_referent] == ["Table 2.1", "Table 3.1"]
    assert facts.per_referent[0].n_rows == 1
    assert facts.per_referent[0].n_cols == 3


def test_n_way_comparison_three_tables() -> None:
    # Comparator is N-way even though production policy caps at 2.
    a = _ref("A", ["id", "x"], [])
    b = _ref("B", ["id", "y"], [])
    c = _ref("C", ["id", "z"], [])
    facts = TableComparator().compare([a, b, c])
    assert len(facts.per_referent) == 3
    assert facts.shared_columns == ["id"]
    assert facts.unique_columns == {"A": ["x"], "B": ["y"], "C": ["z"]}


def test_case_insensitive_shared_columns() -> None:
    a = _ref("A", ["ID", "Name"], [])
    b = _ref("B", ["id", "name"], [])
    facts = TableComparator().compare([a, b])
    # Reported using the first referent's original casing.
    assert facts.shared_columns == ["ID", "Name"]
    assert facts.unique_columns == {"A": [], "B": []}


def test_row_alignment_wired_from_aligner() -> None:
    a = _ref("A", ["id", "score"], [["1", "10"], ["2", "20"]])
    b = _ref("B", ["id", "score"], [["1", "10"], ["2", "99"]])
    facts = TableComparator().compare([a, b])
    assert facts.row_alignment is not None
    assert facts.row_alignment.key_columns == ["id"]
    assert facts.row_alignment.aligned_rows == 2
    assert len(facts.row_alignment.differing_cells) == 1


def test_no_shared_key_gives_schema_only() -> None:
    a = _ref("A", ["x"], [["1"]])
    b = _ref("B", ["y"], [["2"]])
    facts = TableComparator().compare([a, b])
    assert facts.shared_columns == []
    assert facts.row_alignment is None


def test_empty_referents() -> None:
    facts = TableComparator().compare([])
    assert facts.per_referent == []
    assert facts.row_alignment is None


def test_single_referent_has_no_alignment() -> None:
    a = _ref("Table 2.1", ["id", "name"], [["1", "a"]])
    facts = TableComparator().compare([a])
    assert len(facts.per_referent) == 1
    assert facts.row_alignment is None
