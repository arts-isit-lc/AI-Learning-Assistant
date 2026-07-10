"""Tests for ComparisonEngine dispatch + policy cap."""

from __future__ import annotations

from ...models.data_models import (
    ComparisonIntent,
    ComparisonType,
    FigureReference,
    QueryIntent,
    ResolutionConfidence,
    ResolvedReferent,
    TableComparisonFacts,
)
from .comparison_engine import ComparisonEngine


class _FakeResolver:
    def __init__(self, referents):
        self._referents = referents
        self.received_refs = None

    def resolve(self, refs, ranked_results, scope_filter=None):
        self.received_refs = refs
        return self._referents


class _FakeComparator:
    def __init__(self):
        self.received = None

    def compare(self, referents):
        self.received = referents
        return TableComparisonFacts()


def _referent(label):
    return ResolvedReferent(label, label, label, ResolutionConfidence.HIGH)


def _table_comparison_intent(numbers):
    intent = QueryIntent()
    intent.requires_table_comparison = True
    intent.figure_references = [FigureReference("table", n) for n in numbers]
    return intent


def test_dispatches_table_comparison() -> None:
    resolver = _FakeResolver([_referent("Table 2.1"), _referent("Table 3.1")])
    comparator = _FakeComparator()
    engine = ComparisonEngine(
        resolvers={ComparisonType.TABLE: resolver},
        comparators={ComparisonType.TABLE: comparator},
    )
    result = engine.compare(_table_comparison_intent(["2.1", "3.1"]), [], None)
    assert result is not None
    assert result.comparison_type is ComparisonType.TABLE
    assert result.intent is ComparisonIntent.COMPARE
    assert len(result.referents) == 2
    assert comparator.received is result.referents


def test_caps_referents_at_two() -> None:
    resolver = _FakeResolver([_referent("Table 1"), _referent("Table 2")])
    engine = ComparisonEngine(
        resolvers={ComparisonType.TABLE: resolver},
        comparators={ComparisonType.TABLE: _FakeComparator()},
        max_referents=2,
    )
    engine.compare(_table_comparison_intent(["1", "2", "3"]), [], None)
    # The resolver only ever sees the first 2 referenced tables.
    assert len(resolver.received_refs) == 2


def test_non_comparison_intent_returns_none() -> None:
    engine = ComparisonEngine(
        resolvers={ComparisonType.TABLE: _FakeResolver([])},
        comparators={ComparisonType.TABLE: _FakeComparator()},
    )
    assert engine.compare(QueryIntent(), [], None) is None


def test_no_registered_resolver_returns_none() -> None:
    engine = ComparisonEngine(resolvers={}, comparators={})
    assert engine.compare(_table_comparison_intent(["2.1", "3.1"]), [], None) is None


def test_no_resolved_referents_returns_none() -> None:
    engine = ComparisonEngine(
        resolvers={ComparisonType.TABLE: _FakeResolver([])},
        comparators={ComparisonType.TABLE: _FakeComparator()},
    )
    assert engine.compare(_table_comparison_intent(["2.1", "3.1"]), [], None) is None


# --- Formula dispatch (Phase 1) --------------------------------------------

from ...models.data_models import FormulaReference  # noqa: E402


def _formula_comparison_intent(numbers):
    intent = QueryIntent()
    intent.requires_formula_comparison = True
    intent.formula_references = [FormulaReference(number=n) for n in numbers]
    return intent


def test_dispatches_formula_comparison():
    resolver = _FakeResolver([_referent("Equation 3.4"), _referent("Equation 5.2")])
    comparator = _FakeComparator()
    engine = ComparisonEngine(
        resolvers={ComparisonType.FORMULA: resolver},
        comparators={ComparisonType.FORMULA: comparator},
    )
    result = engine.compare(_formula_comparison_intent(["3.4", "5.2"]), [], None)
    assert result is not None
    assert result.comparison_type is ComparisonType.FORMULA
    assert result.intent is ComparisonIntent.COMPARE
    assert [(r.number) for r in resolver.received_refs] == ["3.4", "5.2"]


def test_formula_comparison_keyword_only_dispatches_with_empty_refs():
    # No numbered refs (keyword-only query) — engine still dispatches; the
    # resolver receives [] and is expected to fall back to top retrieved formulas.
    resolver = _FakeResolver([_referent("Formula 1"), _referent("Formula 2")])
    engine = ComparisonEngine(
        resolvers={ComparisonType.FORMULA: resolver},
        comparators={ComparisonType.FORMULA: _FakeComparator()},
    )
    intent = QueryIntent()
    intent.requires_formula_comparison = True  # no formula_references
    result = engine.compare(intent, [], None)
    assert result is not None
    assert resolver.received_refs == []


def test_table_takes_precedence_over_formula():
    # If both flags were somehow set, TABLE wins in _plan.
    intent = _formula_comparison_intent(["3.4", "5.2"])
    intent.requires_table_comparison = True
    intent.figure_references = [FigureReference("table", "1"), FigureReference("table", "2")]
    engine = ComparisonEngine(
        resolvers={ComparisonType.TABLE: _FakeResolver([_referent("Table 1"), _referent("Table 2")])},
        comparators={ComparisonType.TABLE: _FakeComparator()},
    )
    result = engine.compare(intent, [], None)
    assert result.comparison_type is ComparisonType.TABLE
