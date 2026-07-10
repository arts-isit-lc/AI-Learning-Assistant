"""Tests for FormulaComparator (Tier 1 pure; Tier 2 via injected checker)."""

from __future__ import annotations

from ...models.data_models import (
    EquivalenceResult,
    EquivalenceStatus,
    ResolutionConfidence,
    ResolvedReferent,
)
from .formula_comparator import FormulaComparator


def _ref(label, latex) -> ResolvedReferent:
    return ResolvedReferent(
        reference=label,
        retrieval_id=label,
        parent_element_id=label,
        confidence=ResolutionConfidence.HIGH,
        structured_content={"latex": latex},
    )


def test_shared_and_unique_symbols_two_formulas():
    a = _ref("Equation 3.4", r"y = w x + b")
    b = _ref("Equation 5.2", r"y = w x + b + \lambda")
    facts = FormulaComparator().compare([a, b])
    assert set(facts.shared["variables"]) == {"y", "w", "x", "b"}
    # λ is only in 5.2
    assert facts.unique["Equation 5.2"]["greek"] == ["lambda"]
    assert facts.unique["Equation 3.4"]["greek"] == []


def test_equivalence_unknown_without_checker():
    facts = FormulaComparator().compare([_ref("A", "x+1"), _ref("B", "1+x")])
    assert facts.equivalence.status is EquivalenceStatus.UNKNOWN


def test_n_way_three_formulas():
    facts = FormulaComparator().compare([
        _ref("A", r"\alpha x"),
        _ref("B", r"\beta x"),
        _ref("C", r"\gamma x"),
    ])
    assert len(facts.per_referent) == 3
    assert facts.shared["variables"] == ["x"]
    assert facts.unique["A"]["greek"] == ["alpha"]


class _FakeChecker:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    def check(self, left, right):
        self.calls += 1
        return self.result


def test_equivalence_from_checker():
    checker = _FakeChecker(EquivalenceResult(status=EquivalenceStatus.EQUIVALENT, method="sympy"))
    facts = FormulaComparator(equivalence_checker=checker).compare([_ref("A", "x+1"), _ref("B", "1+x")])
    assert facts.equivalence.status is EquivalenceStatus.EQUIVALENT
    assert checker.calls == 1


def test_checker_not_called_for_single_referent():
    checker = _FakeChecker(EquivalenceResult(status=EquivalenceStatus.EQUIVALENT))
    facts = FormulaComparator(equivalence_checker=checker).compare([_ref("A", "x")])
    assert checker.calls == 0
    assert facts.equivalence.status is EquivalenceStatus.UNKNOWN


def test_checker_failure_degrades_to_unknown():
    class _Boom:
        def check(self, left, right):
            raise RuntimeError("sympy exploded")

    facts = FormulaComparator(equivalence_checker=_Boom()).compare([_ref("A", "x"), _ref("B", "y")])
    assert facts.equivalence.status is EquivalenceStatus.UNKNOWN


def test_reads_content_when_latex_absent():
    a = ResolvedReferent("A", "A", "A", ResolutionConfidence.HIGH, structured_content={"content": "x + y"})
    b = ResolvedReferent("B", "B", "B", ResolutionConfidence.HIGH, structured_content={"content": "x + z"})
    facts = FormulaComparator().compare([a, b])
    assert facts.shared["variables"] == ["x"]


def test_empty_referents():
    facts = FormulaComparator().compare([])
    assert facts.per_referent == []
    assert facts.equivalence.status is EquivalenceStatus.UNKNOWN
