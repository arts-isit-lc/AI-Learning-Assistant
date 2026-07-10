"""Tests for cross-modal grounding wiring in ReasoningEngine (T4/T5).

Covers _handle_cross_modal_grounding (gate, table resolution incl. top-table
fallback, delegation to escalation, graceful degrade), the precedence that lets
grounding replace plain image escalation, and _format_grounding_section.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from ..models.data_models import (
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeContextBuilder:
    def format_for_prompt(self, context, module_context=None):
        return "BASE CONTEXT"


class _FakeTableResolver:
    """Returns preset referents regardless of input (deterministic)."""

    def __init__(self, referents):
        self._referents = referents

    def resolve(self, refs, ranked_results, scope_filter=None):
        return list(self._referents)


def _image_ranked(rid="img-1", key="images/c/m/fig4.png", score=0.9) -> RankedResult:
    return RankedResult(
        retrieval_id=rid, parent_element_id=f"p-{rid}", content="A map",
        element_type=ElementType.IMAGE, score=score, cross_encoder_score=0.0,
        metadata_boost=0.0, metadata={"provenance_page_num": 4}, image_s3_key=key,
    )


def _table_ranked(rid="tbl-1") -> RankedResult:
    return RankedResult(
        retrieval_id=rid, parent_element_id=f"p-{rid}", content="Table 3.2 data",
        element_type=ElementType.TABLE, score=0.8, cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={"table_headers": ["Region", "Pop"], "table_rows": [["N", "1"]], "table_summary": "s"},
    )


def _referent(label="Table 3.2", confidence=ResolutionConfidence.HIGH) -> ResolvedReferent:
    return ResolvedReferent(
        reference=label, retrieval_id="tbl-1", parent_element_id="p-tbl-1",
        confidence=confidence,
        structured_content={"headers": ["Region", "Pop"], "rows": [["N", "1"]], "summary": "s"},
        result=_table_ranked(),
    )


def _grounding_va(low=False) -> VisionAnalysis:
    art = GroundedArtifact(ElementType.TABLE, "Table 3.2", {"headers": ["Region"], "rows": [["N"]]})
    res = GroundingResolution(
        artifact=art, ranked_result=_table_ranked(),
        confidence=ResolutionConfidence.LOW if low else ResolutionConfidence.HIGH,
    )
    img = _image_ranked()
    return VisionAnalysis(
        mode=VisionMode.CROSS_MODAL_GROUNDING,
        analysis="North maps to the top-left region of the map.",
        confidence=0.9,
        resolved_images=[img],
        reference_mapping=[ResolvedReference("Figure 4", img.retrieval_id, img.image_s3_key, ResolutionConfidence.HIGH)],
        prompt_intent="ground",
        resolved_artifacts=[res],
    )


def _grounding_intent() -> QueryIntent:
    intent = QueryIntent()
    intent.requires_cross_modal_grounding = True
    intent.requires_image = True  # a grounding query typically sets this too
    intent.figure_references = [FigureReference("table", "3.2"), FigureReference("figure", "4")]
    return intent


def _engine(image_escalation, table_resolver=None) -> ReasoningEngine:
    return ReasoningEngine(
        bedrock_client=None,
        context_builder=_FakeContextBuilder(),
        image_escalation=image_escalation,
        table_resolver=table_resolver,
    )


def _escalation_mock(result: EscalationResult) -> MagicMock:
    m = MagicMock()
    m.escalate_cross_modal_grounding.return_value = result
    return m


# ---------------------------------------------------------------------------
# _handle_cross_modal_grounding
# ---------------------------------------------------------------------------


class TestHandleCrossModalGrounding:
    def test_both_resolve_returns_result(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        result = EscalationResult(escalation_used=True, vision_analysis=_grounding_va())
        esc = _escalation_mock(result)
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        out = eng._handle_cross_modal_grounding("q", [_image_ranked()], _grounding_intent(), None)

        assert out is result
        esc.escalate_cross_modal_grounding.assert_called_once()
        passed = esc.escalate_cross_modal_grounding.call_args.kwargs["table_resolution"]
        assert isinstance(passed, GroundingResolution)
        assert passed.artifact.artifact_type is ElementType.TABLE
        assert passed.artifact.label == "Table 3.2"
        # The pure artifact must carry the resolver's structured content.
        assert passed.artifact.structured_content["headers"] == ["Region", "Pop"]

    def test_gate_flag_off_returns_none(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", False)
        esc = _escalation_mock(EscalationResult(escalation_used=True, vision_analysis=_grounding_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        out = eng._handle_cross_modal_grounding("q", [_image_ranked()], _grounding_intent(), None)

        assert out is None
        esc.escalate_cross_modal_grounding.assert_not_called()

    def test_not_requested_returns_none(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        esc = _escalation_mock(EscalationResult(escalation_used=True, vision_analysis=_grounding_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        intent = QueryIntent()  # requires_cross_modal_grounding stays False
        out = eng._handle_cross_modal_grounding("q", [_image_ranked()], intent, None)

        assert out is None
        esc.escalate_cross_modal_grounding.assert_not_called()

    def test_no_table_resolved_degrades_to_none(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        esc = _escalation_mock(EscalationResult(escalation_used=True, vision_analysis=_grounding_va()))
        # No table refs resolvable and NO table in ranked results.
        eng = _engine(esc, table_resolver=_FakeTableResolver([]))

        out = eng._handle_cross_modal_grounding("q", [_image_ranked()], _grounding_intent(), None)

        assert out is None
        esc.escalate_cross_modal_grounding.assert_not_called()

    def test_fallback_to_top_retrieved_table(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        esc = _escalation_mock(EscalationResult(escalation_used=True, vision_analysis=_grounding_va()))
        eng = _engine(esc, table_resolver=None)  # no resolver -> fallback path

        intent = QueryIntent()
        intent.requires_cross_modal_grounding = True  # no numbered table ref
        out = eng._handle_cross_modal_grounding(
            "q", [_image_ranked(), _table_ranked()], intent, None
        )

        assert out is not None
        passed = esc.escalate_cross_modal_grounding.call_args.kwargs["table_resolution"]
        assert passed.confidence is ResolutionConfidence.MEDIUM
        assert passed.artifact.structured_content["headers"] == ["Region", "Pop"]

    def test_escalation_not_used_returns_none(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        esc = _escalation_mock(EscalationResult(escalation_used=False))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        out = eng._handle_cross_modal_grounding("q", [_image_ranked()], _grounding_intent(), None)

        assert out is None


# ---------------------------------------------------------------------------
# Precedence: grounding replaces plain image escalation
# ---------------------------------------------------------------------------


class TestPrecedence:
    def test_grounding_skips_image_escalation(self, monkeypatch):
        monkeypatch.setattr(re_mod, "CROSS_MODAL_GROUNDING_ENABLED", True)
        # Return passages (skip the reasoning LLM) so no bedrock client is needed.
        monkeypatch.setattr(re_mod, "RAG_RETURN_PASSAGES", True)
        esc = _escalation_mock(EscalationResult(escalation_used=True, vision_analysis=_grounding_va()))
        eng = _engine(esc, table_resolver=_FakeTableResolver([_referent()]))

        result = eng.generate_answer(
            query="map Table 3.2 onto Figure 4",
            context=StructuredContext(),
            ranked_results=[_image_ranked(), _table_ranked()],
            query_intent=_grounding_intent(),
        )

        # Grounding won -> normal single/multi escalation was NOT invoked.
        esc.escalate.assert_not_called()
        assert result.vision_analysis is not None
        assert result.vision_analysis.mode is VisionMode.CROSS_MODAL_GROUNDING
        assert "## Cross-Modal Grounding" in result.answer


# ---------------------------------------------------------------------------
# _format_grounding_section (T5)
# ---------------------------------------------------------------------------


class TestFormatGroundingSection:
    def _engine(self):
        return ReasoningEngine(context_builder=_FakeContextBuilder())

    def test_labels_reference_and_figure(self):
        section = self._engine()._format_grounding_section(_grounding_va())
        assert "## Cross-Modal Grounding: Table 3.2 mapped onto Figure 4" in section
        assert "North maps to the top-left region" in section
        assert "Answer using ONLY" in section
        # No hedge when everything resolved with confidence.
        assert "low-confidence match" not in section

    def test_low_confidence_hedge(self):
        section = self._engine()._format_grounding_section(_grounding_va(low=True))
        assert "low-confidence match" in section
