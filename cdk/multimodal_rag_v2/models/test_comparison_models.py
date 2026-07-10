"""Construction/default tests for the structured-comparison data models."""

from __future__ import annotations

from .data_models import (
    ComparisonIntent,
    ComparisonType,
    ComparisonFacts,
    ElementType,
    RankedResult,
    ReasoningResult,
    ResolutionConfidence,
    ResolvedReferent,
    RowAlignmentResult,
    StructuredComparison,
    TableComparisonFacts,
    TableShape,
)


def _ranked_table(retrieval_id: str, parent: str) -> RankedResult:
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id=parent,
        content="Table 2.1 summary",
        element_type=ElementType.TABLE,
        score=1.0,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={"table_headers": ["id", "name"]},
    )


def test_enum_values() -> None:
    assert ComparisonType.TABLE.value == "table"
    assert ComparisonIntent.COMPARE.value == "compare"
    assert ComparisonIntent.DESCRIBE.value == "describe"


def test_resolved_referent_defaults() -> None:
    ref = ResolvedReferent(
        reference="Table 2.1",
        retrieval_id="r1",
        parent_element_id="p1",
        confidence=ResolutionConfidence.HIGH,
    )
    assert ref.structured_content == {}
    assert ref.result is None


def test_table_comparison_facts_is_comparison_facts() -> None:
    facts = TableComparisonFacts(
        per_referent=[TableShape("Table 2.1", 3, 2, ["id", "name"])],
        shared_columns=["id"],
        unique_columns={"Table 2.1": ["name"]},
        row_alignment=RowAlignmentResult(key_columns=["id"], aligned_rows=3),
    )
    assert isinstance(facts, ComparisonFacts)
    assert facts.per_referent[0].n_cols == 2
    assert facts.row_alignment.aligned_rows == 3


def test_structured_comparison_resolved_results_property() -> None:
    r1 = ResolvedReferent("Table 2.1", "r1", "p1", ResolutionConfidence.HIGH, result=_ranked_table("r1", "p1"))
    r2 = ResolvedReferent("Table 3.1", "r2", "p2", ResolutionConfidence.MEDIUM)  # no result
    sc = StructuredComparison(
        comparison_type=ComparisonType.TABLE,
        intent=ComparisonIntent.COMPARE,
        referents=[r1, r2],
        facts=TableComparisonFacts(),
    )
    # Only referents carrying a RankedResult appear in the display union.
    assert [r.retrieval_id for r in sc.resolved_results] == ["r1"]
    assert sc.degraded is False


def test_reasoning_result_structured_comparison_defaults_none() -> None:
    rr = ReasoningResult(answer="a", sources=[])
    assert rr.structured_comparison is None


# --- Formula comparison models (Phase 1) -----------------------------------

from .data_models import (  # noqa: E402
    EquationType,
    EquivalenceResult,
    EquivalenceStatus,
    FormulaComparisonFacts,
    FormulaProfile,
    FormulaReference,
    QueryIntent,
)


def test_comparison_type_has_formula() -> None:
    assert ComparisonType.FORMULA.value == "formula"


def test_formula_reference_defaults() -> None:
    ref = FormulaReference()
    assert ref.number == ""
    assert ref.keyword == ""
    ref2 = FormulaReference(number="3.4", keyword="equation")
    assert (ref2.number, ref2.keyword) == ("3.4", "equation")


def test_equation_and_equivalence_enums() -> None:
    assert EquationType.OPTIMIZATION_OBJECTIVE.value == "optimization_objective"
    assert EquationType.UNKNOWN.value == "unknown"
    assert EquivalenceStatus.EQUIVALENT.value == "equivalent"
    assert EquivalenceStatus.UNKNOWN.value == "unknown"


def test_equivalence_result_default_unknown() -> None:
    er = EquivalenceResult()
    assert er.status is EquivalenceStatus.UNKNOWN
    assert er.method == "" and er.reason == ""


def test_formula_profile_defaults() -> None:
    p = FormulaProfile(label="Equation 3.4")
    assert p.equation_type is EquationType.UNKNOWN
    assert p.variables == [] and p.functions == []
    assert p.tokens == [] and p.normalized_tokens == []


def test_formula_comparison_facts_is_comparison_facts_and_unknown_by_default() -> None:
    facts = FormulaComparisonFacts(per_referent=[FormulaProfile(label="A")])
    assert isinstance(facts, ComparisonFacts)
    # Each FormulaComparisonFacts gets its own EquivalenceResult (default_factory).
    assert facts.equivalence.status is EquivalenceStatus.UNKNOWN
    other = FormulaComparisonFacts()
    assert other.equivalence is not facts.equivalence


def test_query_intent_formula_defaults() -> None:
    intent = QueryIntent()
    assert intent.formula_references == []
    assert intent.requires_formula_comparison is False
