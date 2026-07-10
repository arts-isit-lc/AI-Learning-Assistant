"""Tests for structured-comparison wiring in ReasoningEngine (T7)."""

from __future__ import annotations

from unittest.mock import MagicMock

from ..models.data_models import (
    ComparisonIntent,
    ComparisonType,
    FigureReference,
    QueryIntent,
    ResolutionConfidence,
    ResolvedReferent,
    StructuredComparison,
    StructuredContext,
)
from . import reasoning_engine as re_mod
from .reasoning_engine import ReasoningEngine
from .comparison.table_comparator import TableComparator


def _referent(label, headers, rows, confidence=ResolutionConfidence.HIGH) -> ResolvedReferent:
    return ResolvedReferent(
        reference=label,
        retrieval_id=label,
        parent_element_id=label,
        confidence=confidence,
        structured_content={"headers": headers, "rows": rows},
    )


def _comparison(referents) -> StructuredComparison:
    facts = TableComparator().compare(referents)
    return StructuredComparison(
        comparison_type=ComparisonType.TABLE,
        intent=ComparisonIntent.COMPARE,
        referents=referents,
        facts=facts,
    )


def _table_intent(numbers):
    intent = QueryIntent()
    intent.requires_table_comparison = True
    intent.requires_image = True  # table refs set this too — comparison must win
    intent.figure_references = [FigureReference("table", n) for n in numbers]
    return intent


class _FakeContextBuilder:
    def format_for_prompt(self, context, module_context=None):
        return "BASE CONTEXT"


class TestFormatComparisonSection:
    def _engine(self):
        return ReasoningEngine(context_builder=_FakeContextBuilder())

    def test_section_has_labels_and_facts(self):
        eng = self._engine()
        sc = _comparison([
            _referent("Table 2.1", ["id", "name", "score"], [["1", "a", "10"]]),
            _referent("Table 3.1", ["id", "name", "region"], [["1", "a", "west"]]),
        ])
        section = eng._format_comparison_section(sc, query_intent=_table_intent(["2.1", "3.1"]))
        assert "## Structured comparison of Table 2.1 and Table 3.1" in section
        assert "Verified facts" in section
        assert "Shared columns: id, name" in section
        assert "Only in Table 2.1: score" in section
        assert "Only in Table 3.1: region" in section
        assert "Do NOT invent cells" in section

    def test_missing_referent_note(self):
        eng = self._engine()
        # Only Table 2.1 resolved though 3.1 was requested.
        sc = _comparison([_referent("Table 2.1", ["id"], [["1"]])])
        section = eng._format_comparison_section(sc, query_intent=_table_intent(["2.1", "3.1"]))
        assert "Table 3.1 could not be located" in section

    def test_low_confidence_hedge(self):
        eng = self._engine()
        sc = _comparison([
            _referent("Table 2.1", ["id"], [["1"]], confidence=ResolutionConfidence.LOW),
            _referent("Table 3.1", ["id"], [["1"]]),
        ])
        section = eng._format_comparison_section(sc, query_intent=_table_intent(["2.1", "3.1"]))
        assert "could not be identified with certainty" in section


class TestHandleStructuredComparison:
    def test_runs_when_flagged(self):
        sc = _comparison([_referent("Table 2.1", ["id"], [["1"]])])
        engine_mock = MagicMock()
        engine_mock.compare.return_value = sc
        eng = ReasoningEngine(context_builder=_FakeContextBuilder(), comparison_engine=engine_mock)
        out = eng._handle_structured_comparison([], _table_intent(["2.1", "3.1"]), None)
        assert out is sc

    def test_skips_when_flag_off(self):
        engine_mock = MagicMock()
        eng = ReasoningEngine(context_builder=_FakeContextBuilder(), comparison_engine=engine_mock)
        assert eng._handle_structured_comparison([], QueryIntent(), None) is None
        engine_mock.compare.assert_not_called()

    def test_skips_when_no_engine(self):
        eng = ReasoningEngine(context_builder=_FakeContextBuilder(), comparison_engine=None)
        assert eng._handle_structured_comparison([], _table_intent(["2.1", "3.1"]), None) is None

    def test_never_raises(self):
        engine_mock = MagicMock()
        engine_mock.compare.side_effect = RuntimeError("boom")
        eng = ReasoningEngine(context_builder=_FakeContextBuilder(), comparison_engine=engine_mock)
        assert eng._handle_structured_comparison([], _table_intent(["2.1", "3.1"]), None) is None


class TestGenerateAnswerComparison:
    def test_comparison_skips_escalation_and_grounds(self, monkeypatch):
        # RAG_RETURN_PASSAGES: return the formatted passages as the answer (no
        # Bedrock needed), so the injected comparison section is observable.
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)

        sc = _comparison([
            _referent("Table 2.1", ["id", "score"], [["1", "10"]]),
            _referent("Table 3.1", ["id", "score"], [["1", "20"]]),
        ])
        comparison_engine = MagicMock()
        comparison_engine.compare.return_value = sc

        image_escalation = MagicMock()

        eng = ReasoningEngine(
            context_builder=_FakeContextBuilder(),
            image_escalation=image_escalation,
            comparison_engine=comparison_engine,
        )
        result = eng.generate_answer(
            query="compare table 2.1 and table 3.1",
            context=StructuredContext(),
            ranked_results=[],
            query_intent=_table_intent(["2.1", "3.1"]),
        )

        # Comparison result is surfaced for the handler union.
        assert result.structured_comparison is sc
        # Image escalation is skipped even though requires_image is True.
        image_escalation.escalate.assert_not_called()
        # Grounding reached the answer (passages mode).
        assert "## Structured comparison of Table 2.1 and Table 3.1" in result.answer
        assert "BASE CONTEXT" in result.answer

    def test_non_comparison_query_uses_escalation_path(self, monkeypatch):
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)
        from .image_escalation import EscalationResult

        image_escalation = MagicMock()
        image_escalation.escalate.return_value = EscalationResult(escalation_used=False, image_analyses=[])
        comparison_engine = MagicMock()

        eng = ReasoningEngine(
            context_builder=_FakeContextBuilder(),
            image_escalation=image_escalation,
            comparison_engine=comparison_engine,
        )
        intent = QueryIntent(requires_image=True)
        result = eng.generate_answer(
            query="show me a diagram",
            context=StructuredContext(),
            ranked_results=[],
            query_intent=intent,
        )
        assert result.structured_comparison is None
        comparison_engine.compare.assert_not_called()
        image_escalation.escalate.assert_called_once()


# --- Formula comparison wiring (Phase 1) -----------------------------------

from ..models.data_models import FormulaReference  # noqa: E402
from .formula.formula_comparator import FormulaComparator  # noqa: E402


def _formula_referent(label, latex, confidence=ResolutionConfidence.HIGH):
    return ResolvedReferent(
        reference=label,
        retrieval_id=label,
        parent_element_id=label,
        confidence=confidence,
        structured_content={"latex": latex},
    )


def _formula_comparison(referents):
    facts = FormulaComparator().compare(referents)
    return StructuredComparison(
        comparison_type=ComparisonType.FORMULA,
        intent=ComparisonIntent.COMPARE,
        referents=referents,
        facts=facts,
    )


def _formula_intent(numbers):
    intent = QueryIntent()
    intent.requires_formula_comparison = True
    intent.requires_image = True  # formula path must win over any image intent
    intent.formula_references = [FormulaReference(number=n) for n in numbers]
    return intent


class TestFormatComparisonSectionFormula:
    def _engine(self):
        return ReasoningEngine(context_builder=_FakeContextBuilder())

    def test_section_has_labels_symbols_and_conservative_equivalence(self):
        sc = _formula_comparison([
            _formula_referent("Equation 3.4", r"y = w x + b"),
            _formula_referent("Equation 5.2", r"y = w x + b + \lambda"),
        ])
        section = self._engine()._format_comparison_section(sc, query_intent=_formula_intent(["3.4", "5.2"]))
        assert "## Structured comparison of Equation 3.4 and Equation 5.2" in section
        assert "Verified facts" in section
        assert "Only in Equation 5.2: greek lambda" in section
        # Conservative equivalence wording (Phase 1 has no symbolic engine).
        assert "Symbolic equivalence: not determined" in section
        assert "invent symbols" in section
        assert "do NOT assert mathematical equivalence" in section

    def test_missing_formula_note(self):
        sc = _formula_comparison([_formula_referent("Equation 3.4", "x = 1")])
        section = self._engine()._format_comparison_section(sc, query_intent=_formula_intent(["3.4", "5.2"]))
        assert "Equation 5.2 could not be located" in section


class TestGenerateAnswerFormulaComparison:
    def test_formula_comparison_skips_escalation_and_grounds(self, monkeypatch):
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)
        sc = _formula_comparison([
            _formula_referent("Equation 3.4", "y = w x + b"),
            _formula_referent("Equation 5.2", r"y = w x + b + \lambda"),
        ])
        comparison_engine = MagicMock()
        comparison_engine.compare.return_value = sc
        image_escalation = MagicMock()

        eng = ReasoningEngine(
            context_builder=_FakeContextBuilder(),
            image_escalation=image_escalation,
            comparison_engine=comparison_engine,
        )
        result = eng.generate_answer(
            query="compare equation 3.4 and equation 5.2",
            context=StructuredContext(),
            ranked_results=[],
            query_intent=_formula_intent(["3.4", "5.2"]),
        )
        assert result.structured_comparison is sc
        image_escalation.escalate.assert_not_called()
        assert "## Structured comparison of Equation 3.4 and Equation 5.2" in result.answer
