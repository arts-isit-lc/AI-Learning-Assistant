"""Tests for RowAligner + ExactHeaderKeyStrategy."""

from __future__ import annotations

from ...models.data_models import ResolutionConfidence, ResolvedReferent, TableShape
from .row_aligner import ExactHeaderKeyStrategy, RowAligner


def _ref(label, headers, rows) -> ResolvedReferent:
    return ResolvedReferent(
        reference=label,
        retrieval_id=label,
        parent_element_id=label,
        confidence=ResolutionConfidence.HIGH,
        structured_content={"headers": headers, "rows": rows},
    )


def _shape(label, headers, rows) -> TableShape:
    return TableShape(label=label, n_rows=len(rows), n_cols=len(headers), columns=list(headers))


class TestExactHeaderKeyStrategy:
    def test_prefers_id_hint_over_non_hint_first_column(self) -> None:
        # "alpha" is first but not an identifier hint; "id" is -> key is "id".
        shapes = [_shape("A", ["alpha", "id"], []), _shape("B", ["id", "alpha"], [])]
        assert ExactHeaderKeyStrategy().choose_key(shapes) == ["id"]

    def test_first_hint_in_order_wins_when_multiple_hints(self) -> None:
        # Both "name" and "id" are hints; the first in the first shape's order wins.
        shapes = [_shape("A", ["name", "id"], []), _shape("B", ["id", "name"], [])]
        assert ExactHeaderKeyStrategy().choose_key(shapes) == ["name"]

    def test_falls_back_to_first_shared_column(self) -> None:
        shapes = [_shape("A", ["foo", "bar"], []), _shape("B", ["foo", "baz"], [])]
        assert ExactHeaderKeyStrategy().choose_key(shapes) == ["foo"]

    def test_normalizes_case_and_whitespace(self) -> None:
        shapes = [_shape("A", [" ID "], []), _shape("B", ["id"], [])]
        assert ExactHeaderKeyStrategy().choose_key(shapes) == [" ID "]

    def test_no_shared_column_returns_none(self) -> None:
        shapes = [_shape("A", ["x"], []), _shape("B", ["y"], [])]
        assert ExactHeaderKeyStrategy().choose_key(shapes) is None

    def test_single_shape_returns_none(self) -> None:
        assert ExactHeaderKeyStrategy().choose_key([_shape("A", ["id"], [])]) is None


class TestRowAligner:
    def test_aligns_and_reports_diffs(self) -> None:
        a = _ref("Table 2.1", ["id", "score"], [["1", "10"], ["2", "20"]])
        b = _ref("Table 3.1", ["id", "score"], [["1", "10"], ["2", "99"], ["3", "30"]])
        shapes = [
            _shape("Table 2.1", ["id", "score"], a.structured_content["rows"]),
            _shape("Table 3.1", ["id", "score"], b.structured_content["rows"]),
        ]
        result = RowAligner().align([a, b], shapes)
        assert result is not None
        assert result.key_columns == ["id"]
        assert result.aligned_rows == 2  # keys 1 and 2
        # key 2 differs on score (20 vs 99)
        assert len(result.differing_cells) == 1
        diff = result.differing_cells[0]
        assert diff["key"] == "2"
        assert diff["column"] == "score"
        assert diff["values_by_label"] == {"Table 2.1": "20", "Table 3.1": "99"}
        assert result.unaligned_by_label == {"Table 2.1": 0, "Table 3.1": 1}

    def test_no_key_returns_none(self) -> None:
        a = _ref("A", ["x"], [["1"]])
        b = _ref("B", ["y"], [["2"]])
        shapes = [_shape("A", ["x"], [["1"]]), _shape("B", ["y"], [["2"]])]
        assert RowAligner().align([a, b], shapes) is None

    def test_differing_cells_bounded(self) -> None:
        rows_a = [[str(i), "a"] for i in range(100)]
        rows_b = [[str(i), "b"] for i in range(100)]
        a = _ref("A", ["id", "v"], rows_a)
        b = _ref("B", ["id", "v"], rows_b)
        shapes = [_shape("A", ["id", "v"], rows_a), _shape("B", ["id", "v"], rows_b)]
        result = RowAligner(max_differing_cells=10).align([a, b], shapes)
        assert result is not None
        assert len(result.differing_cells) == 10
