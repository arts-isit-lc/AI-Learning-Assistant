"""Tests for TableReferenceResolver (resolution decoupled from comparison)."""

from __future__ import annotations

from ..models.data_models import (
    ElementType,
    FigureReference,
    RankedResult,
    ResolutionConfidence,
)
from .reference_resolver import TableReferenceResolver


# --- Fakes ------------------------------------------------------------------

class _FakeCursor:
    def __init__(self, fetchone_queue, fetchall_queue):
        self._one = list(fetchone_queue)
        self._all = list(fetchall_queue)
        self.executed: list[tuple] = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._one.pop(0) if self._one else None

    def fetchall(self):
        return self._all.pop(0) if self._all else []

    def close(self):
        pass


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor


def _resolver_with_db(fetchone_queue, fetchall_queue):
    cursor = _FakeCursor(fetchone_queue, fetchall_queue)
    resolver = TableReferenceResolver(db_connection_factory=lambda: _FakeConn(cursor))
    return resolver, cursor


def _table_ranked(retrieval_id, parent, content, headers=None, rows=None, summary="") -> RankedResult:
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id=parent,
        content=content,
        element_type=ElementType.TABLE,
        score=0.9,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={
            "table_headers": headers or [],
            "table_rows": rows or [],
            "table_summary": summary,
            "module_id": "m1",
            "provenance_page_num": 5,
        },
    )


_TABLE_META = {
    "table_headers": ["id", "name"],
    "table_rows": [["1", "a"]],
    "table_summary": "Table 2.1 dataset",
    "module_id": "m1",
    "provenance_page_num": 5,
}


# --- Tests ------------------------------------------------------------------

def test_resolves_from_ranked_results_high_confidence() -> None:
    resolver = TableReferenceResolver(db_connection_factory=None)
    results = [_table_ranked("r1", "p1", "Table 2.1 dataset of scores", ["id", "score"], [["1", "9"]])]
    out = resolver.resolve([FigureReference("table", "2.1")], results)
    assert len(out) == 1
    assert out[0].confidence is ResolutionConfidence.HIGH
    assert out[0].retrieval_id == "r1"
    assert out[0].structured_content["headers"] == ["id", "score"]
    assert out[0].result is results[0]


def test_single_db_match_is_high() -> None:
    resolver, cursor = _resolver_with_db(
        fetchone_queue=[("r9", "p9", "Table 2.1 summary", dict(_TABLE_META))],
        fetchall_queue=[[("p9", "m1")]],  # one candidate, one module
    )
    out = resolver.resolve([FigureReference("table", "2.1")], [], scope_filter={"file_id": ["fA"]})
    assert len(out) == 1
    assert out[0].confidence is ResolutionConfidence.HIGH
    assert out[0].structured_content["summary"] == "Table 2.1 dataset"
    # Scope threaded into BOTH queries.
    assert any("file_id = ANY(%s)" in sql for sql, _ in cursor.executed)
    assert any(["fA"] in (params or []) for _, params in cursor.executed)


def test_two_candidates_same_module_is_medium() -> None:
    resolver, _ = _resolver_with_db(
        fetchone_queue=[("r1", "p1", "Table 2.1", dict(_TABLE_META))],
        fetchall_queue=[[("p1", "m1"), ("p2", "m1")]],
    )
    out = resolver.resolve([FigureReference("table", "2.1")], [])
    assert out[0].confidence is ResolutionConfidence.MEDIUM


def test_candidates_across_modules_is_low() -> None:
    resolver, _ = _resolver_with_db(
        fetchone_queue=[("r1", "p1", "Table 2.1", dict(_TABLE_META))],
        fetchall_queue=[[("p1", "m1"), ("p2", "m2")]],
    )
    out = resolver.resolve([FigureReference("table", "2.1")], [])
    assert out[0].confidence is ResolutionConfidence.LOW


def test_non_table_refs_ignored() -> None:
    resolver = TableReferenceResolver(db_connection_factory=None)
    out = resolver.resolve([FigureReference("figure", "4.1")], [])
    assert out == []


def test_no_match_returns_nothing() -> None:
    resolver, _ = _resolver_with_db(fetchone_queue=[None], fetchall_queue=[[]])
    out = resolver.resolve([FigureReference("table", "9.9")], [])
    assert out == []


def test_dedupes_two_refs_to_same_physical_table() -> None:
    # Both references land on the same parent (parent p1) -> only one referent.
    resolver = TableReferenceResolver(db_connection_factory=None)
    results = [
        _table_ranked("r1", "p1", "Table 2.1 and Table 3.1 combined view"),
    ]
    out = resolver.resolve(
        [FigureReference("table", "2.1"), FigureReference("table", "3.1")], results
    )
    assert len(out) == 1


# ---------------------------------------------------------------------------
# FormulaReferenceResolver (Phase 1)
# ---------------------------------------------------------------------------

from ..models.data_models import FormulaReference  # noqa: E402
from .reference_resolver import FormulaReferenceResolver  # noqa: E402


def _formula_resolver_with_db(fetchone_queue, fetchall_queue):
    cursor = _FakeCursor(fetchone_queue, fetchall_queue)
    resolver = FormulaReferenceResolver(db_connection_factory=lambda: _FakeConn(cursor))
    return resolver, cursor


def _formula_ranked(rid, parent, content, latex="", module="m1", page=3) -> RankedResult:
    return RankedResult(
        retrieval_id=rid,
        parent_element_id=parent,
        content=content,
        element_type=ElementType.FORMULA,
        score=0.9,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={"latex_repr": latex, "formula_concepts": [], "module_id": module, "page_num": page},
    )


_FORMULA_META = {
    "latex_repr": "E = m c^2",
    "formula_concepts": ["energy"],
    "module_id": "m1",
    "page_num": 3,
}


class TestFormulaResolverNumbered:
    def test_numbered_in_context_is_high(self):
        resolver = FormulaReferenceResolver(db_connection_factory=None)
        ranked = [_formula_ranked("f1", "p1", "Equation 3.4: E = m c^2", latex="E = m c^2")]
        out = resolver.resolve([FormulaReference(number="3.4", keyword="equation")], ranked)
        assert len(out) == 1
        assert out[0].confidence is ResolutionConfidence.HIGH
        assert out[0].reference == "Equation 3.4"
        assert out[0].structured_content["latex"] == "E = m c^2"
        assert out[0].result is ranked[0]

    def test_numbered_single_db_match_is_high_and_scoped(self):
        resolver, cursor = _formula_resolver_with_db(
            fetchone_queue=[("f9", "p9", "Equation 3.4", dict(_FORMULA_META))],
            fetchall_queue=[[("p9", "m1")]],
        )
        out = resolver.resolve([FormulaReference(number="3.4")], [], scope_filter={"file_id": ["fA"]})
        assert out[0].confidence is ResolutionConfidence.HIGH
        assert out[0].structured_content["concepts"] == ["energy"]
        assert any("element_type = 'formula'" in sql for sql, _ in cursor.executed)
        assert any(["fA"] in (params or []) for _, params in cursor.executed)

    def test_cross_module_candidates_is_low(self):
        resolver, _ = _formula_resolver_with_db(
            fetchone_queue=[("f1", "p1", "Equation 3.4", dict(_FORMULA_META))],
            fetchall_queue=[[("p1", "m1"), ("p2", "m2")]],
        )
        out = resolver.resolve([FormulaReference(number="3.4")], [])
        assert out[0].confidence is ResolutionConfidence.LOW


class TestFormulaResolverFallback:
    def test_top_two_retrieved_when_no_numbers(self):
        resolver = FormulaReferenceResolver(db_connection_factory=None)
        ranked = [
            _formula_ranked("f1", "p1", "a = b", latex="a = b"),
            _formula_ranked("f2", "p2", "c = d", latex="c = d"),
            _formula_ranked("f3", "p3", "e = f", latex="e = f"),
        ]
        out = resolver.resolve([], ranked)
        assert [r.reference for r in out] == ["Formula 1", "Formula 2"]
        assert all(r.confidence is ResolutionConfidence.MEDIUM for r in out)

    def test_fallback_fills_after_one_numbered(self):
        resolver = FormulaReferenceResolver(db_connection_factory=None)
        ranked = [
            _formula_ranked("f1", "p1", "Equation 3.4: a=b", latex="a=b"),
            _formula_ranked("f2", "p2", "c = d", latex="c = d"),
        ]
        out = resolver.resolve([FormulaReference(number="3.4")], ranked)
        assert [r.reference for r in out] == ["Equation 3.4", "Formula 2"]
        assert out[0].confidence is ResolutionConfidence.HIGH
        assert out[1].confidence is ResolutionConfidence.MEDIUM

    def test_ignores_non_formula_results(self):
        resolver = FormulaReferenceResolver(db_connection_factory=None)
        ranked = [
            _table_ranked("t1", "tp1", "Table 1"),  # from the table-resolver helpers above
            _formula_ranked("f1", "p1", "a = b", latex="a = b"),
        ]
        out = resolver.resolve([], ranked)
        assert len(out) == 1
        assert out[0].retrieval_id == "f1"

    def test_dedupes_by_parent(self):
        resolver = FormulaReferenceResolver(db_connection_factory=None)
        ranked = [
            _formula_ranked("f1", "shared-parent", "a=b", latex="a=b"),
            _formula_ranked("f2", "shared-parent", "a=b", latex="a=b"),
        ]
        out = resolver.resolve([], ranked)
        assert len(out) == 1

    def test_empty_when_no_formulas(self):
        resolver = FormulaReferenceResolver(db_connection_factory=None)
        assert resolver.resolve([], []) == []
