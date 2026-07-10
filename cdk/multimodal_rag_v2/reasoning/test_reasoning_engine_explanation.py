"""Tests for cross-modal EXPLANATION wiring in ReasoningEngine (T4/T5).

Covers _handle_cross_modal_explanation (gate + delegation with family=EXPLANATION),
the precedence that grounding wins when both families match, and the EXPLANATION
heading in _format_cross_modal_section.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from ..models.data_models import (
    CrossModalFamily,
    ElementType,
    FigureReference,
    GroundedArtifact,
    GroundingResolution,
    QueryIntent,
    RankedResult,
    ResolutionConfidence,
    ResolvedReference,
    ResolvedReferent,
    StructuredContext,
    VisionAnalysis,
    VisionMode,
)
from . import reasoning_engine as re_mod
from .image_escalation import EscalationResult
from .reasoning_engine import ReasoningEngine


class _FakeContextBuilder:
    def format_for_prompt(self, context, module_context=None):
        return "BASE CONTEXT"


class _FakeTableResolver:
    def __init__(self, referents):
        self._referents = referents

    def resolve(self, refs, ranked_results, scope_filter=None):
        return list(self._referents)


def _image_ranked() -> RankedResult:
    return RankedResult(
        retrieval_id="img-1", parent_element_id="p", content="A plot",
        element_type=ElementType.IMAGE, score=0.9, cross_encoder_score=0.0,
        metadata_boost=0.0, metadata={}, image_s3_key="images/c/m/fig1.png",
    )


def _table_ranked() -> RankedResult:
    return RankedResult(
        retrieval_id="tbl-1", parent_element_id="p-tbl", content="Table 1.1 data",
        element_type=ElementType.TABLE, score=0.8, cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={"table_headers": ["Region"], "table_rows": [["N"]], "table_summary": "s"},
    )


def _referent() -> ResolvedReferent:
    return ResolvedReferent(
        reference="Table 1.1", retrieval_id="tbl-1", parent_element_id="p-tbl",
        confidence=ResolutionConfidence.HIGH,
        structured_content={"headers": ["Region"], "rows": [["N"]], "summary": "s"},
        result=_table_ranked(),
    )


def _explanation_va(low=False) -> VisionAnalysis:
    res = GroundingResolution(
        artifact=GroundedArtifact(ElementType.TABLE, "Table 1.1", {"headers": ["Region"]}),
        ranked_result=_table_ranked(),
        confidence=ResolutionConfidence.LOW if low else ResolutionConfidence.HIGH,
    )
    img = _image_ranked()
    return VisionAnalysis(
        mode=VisionMode.CROSS_MODAL,
        analysis="The table's values explain the plotted trend.",
        confidence=0.9,
        resolved_images=[img],
        reference_mapping=[ResolvedReference("Figure 1.1", img.retrieval_id, img.image_s3_key, ResolutionConfidence.HIGH)],
        cross_modal_family=CrossModalFamily.EXPLANATION,
        resolved_artifacts=[res],
    )


def _explanation_intent() -> QueryIntent:
    intent = QueryIntent()
    intent.requires_cross_modal_explanation = True
    # An explanation query names a table + a figure ("how does Table 1.1 relate to
    # Figure 1.1"); the table ref lets the resolver resolve it.
    intent.figure_references = [FigureReference("table", "1.1"), FigureReference("figure", "1.1")]
    return intent


def _engine(esc, table_resolver=None) -> ReasoningEngine:
    return ReasoningEngine(
        bedrock_client=None, context_builder=_FakeContextBuilder(),
        image_escalation=esc, table_resolver=table_resolver,
    )


def _mock(result: EscalationResult) -> MagicMock:
    m = MagicMock()
    m.escalate_cross_modal.return_value = result
    return m


class TestHandleCrossModalExplanation:
    def test_both_resolve_uses_explanation_family(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_EXPLANATION_ENABLED", True)
        esc = _mock(EscalationResult(escalation_used=True, vision_analysis=_explanation_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        out = eng._handle_cross_modal_explanation("q", [_image_ranked()], _explanation_intent(), None)

        assert out is not None
        esc.escalate_cross_modal.assert_called_once()
        assert esc.escalate_cross_modal.call_args.kwargs["family"] is CrossModalFamily.EXPLANATION

    def test_gate_flag_off_returns_none(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_EXPLANATION_ENABLED", False)
        esc = _mock(EscalationResult(escalation_used=True, vision_analysis=_explanation_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))
        out = eng._handle_cross_modal_explanation("q", [_image_ranked()], _explanation_intent(), None)
        assert out is None
        esc.escalate_cross_modal.assert_not_called()

    def test_not_requested_returns_none(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_EXPLANATION_ENABLED", True)
        esc = _mock(EscalationResult(escalation_used=True, vision_analysis=_explanation_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))
        out = eng._handle_cross_modal_explanation("q", [_image_ranked()], QueryIntent(), None)
        assert out is None
        esc.escalate_cross_modal.assert_not_called()


class TestPrecedence:
    def test_grounding_wins_when_both_flags_match(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        monkeypatch.setattr(re_mod, "CROSS_MODAL_EXPLANATION_ENABLED", True)
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)
        esc = _mock(EscalationResult(escalation_used=True, vision_analysis=_explanation_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        intent = QueryIntent()
        intent.requires_cross_modal_grounding = True
        intent.requires_cross_modal_explanation = True

        eng.generate_answer(
            query="q", context=StructuredContext(),
            ranked_results=[_image_ranked(), _table_ranked()], query_intent=intent,
        )
        # Grounding runs first; only ONE cross-modal call, with family GROUNDING.
        esc.escalate_cross_modal.assert_called_once()
        assert esc.escalate_cross_modal.call_args.kwargs["family"] is CrossModalFamily.GROUNDING

    def test_explanation_skips_image_escalation(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_EXPLANATION_ENABLED", True)
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)
        esc = _mock(EscalationResult(escalation_used=True, vision_analysis=_explanation_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        result = eng.generate_answer(
            query="how does Table 1.1 relate to Figure 1.1",
            context=StructuredContext(),
            ranked_results=[_image_ranked(), _table_ranked()],
            query_intent=_explanation_intent(),
        )
        esc.escalate.assert_not_called()
        assert result.vision_analysis.mode is VisionMode.CROSS_MODAL
        assert result.vision_analysis.cross_modal_family is CrossModalFamily.EXPLANATION
        assert "## Cross-Modal Explanation" in result.answer


class TestFormatCrossModalSectionExplanation:
    def test_explanation_heading(self):
        eng = ReasoningEngine(context_builder=_FakeContextBuilder())
        section = eng._format_cross_modal_section(_explanation_va())
        assert "## Cross-Modal Explanation: relationship between Table 1.1 and Figure 1.1" in section
        assert "The table's values explain the plotted trend." in section
        assert "do not assert" in section.lower()

    def test_low_confidence_hedge(self):
        eng = ReasoningEngine(context_builder=_FakeContextBuilder())
        section = eng._format_cross_modal_section(_explanation_va(low=True))
        assert "low-confidence match" in section
