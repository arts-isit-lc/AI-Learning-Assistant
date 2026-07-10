"""Tests for cross-modal grounding in ImageEscalation.

Covers escalate_cross_modal_grounding (one Sonnet 4.5 call co-presenting a
rendered structured reference + an image), render_artifact (production TABLE
branch + bounds, plus the plumbing-only fallback), and the abstraction/layering
guarantee that a non-table GroundedArtifact traverses the vision pipeline
unchanged (AC-9, escalation half).
"""

from __future__ import annotations

import json
from io import BytesIO
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
    VisionMode,
)
from .image_escalation import (
    COMPARISON_VISION_MODEL_ID,
    ImageEscalation,
    render_artifact,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_escalation() -> ImageEscalation:
    s3_client = MagicMock()
    s3_client.get_object.return_value = {"Body": BytesIO(b"fake-png-bytes")}

    bedrock_client = MagicMock()
    bedrock_client.invoke_model.return_value = {
        "body": BytesIO(
            json.dumps(
                {
                    "content": [{"text": "Row North maps to the top-left region of the map."}],
                    "stop_reason": "end_turn",
                }
            ).encode()
        )
    }
    return ImageEscalation(
        s3_client=s3_client, bedrock_client=bedrock_client, bucket_name="test-bucket"
    )


def _image_result(rid: str = "img-1", key: str = "images/c/m/fig4.png", score: float = 0.9) -> RankedResult:
    return RankedResult(
        retrieval_id=rid,
        parent_element_id=f"p-{rid}",
        content="A map of regions",
        element_type=ElementType.IMAGE,
        score=score,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={"provenance_page_num": 4},
        image_s3_key=key,
    )


def _table_resolution(
    confidence: ResolutionConfidence = ResolutionConfidence.HIGH,
    label: str = "Table 3.2",
) -> GroundingResolution:
    table = RankedResult(
        retrieval_id="tbl-1",
        parent_element_id="p-tbl-1",
        content="Table 3.2 population by region",
        element_type=ElementType.TABLE,
        score=0.8,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata={},
    )
    artifact = GroundedArtifact(
        artifact_type=ElementType.TABLE,
        label=label,
        structured_content={
            "headers": ["Region", "Population"],
            "rows": [["North", "100"], ["South", "200"]],
            "summary": "Population by region",
        },
    )
    return GroundingResolution(artifact=artifact, ranked_result=table, confidence=confidence)


def _invoke_body_and_model(esc: ImageEscalation) -> tuple[dict, str]:
    kwargs = esc.bedrock_client.invoke_model.call_args.kwargs
    return json.loads(kwargs["body"]), kwargs["modelId"]


# ---------------------------------------------------------------------------
# escalate_cross_modal_grounding — the critical-path test (AC-2)
# ---------------------------------------------------------------------------


class TestGroundingVisionCall:
    def test_single_call_has_both_reference_text_and_image_and_sonnet(self) -> None:
        esc = _make_escalation()
        results = [_image_result()]
        intent = QueryIntent(requires_cross_modal_grounding=True)

        out = esc.escalate_cross_modal_grounding(
            results=results, query="map Table 3.2 onto the map", table_resolution=_table_resolution(),
            query_intent=intent,
        )

        assert out.escalation_used is True
        # Exactly ONE vision call.
        assert esc.bedrock_client.invoke_model.call_count == 1
        body, model_id = _invoke_body_and_model(esc)
        # Sonnet 4.5 comparison profile.
        assert model_id == COMPARISON_VISION_MODEL_ID
        content = body["messages"][0]["content"]
        image_blocks = [b for b in content if b["type"] == "image"]
        text_blocks = [b["text"] for b in content if b["type"] == "text"]
        # BOTH a single image block AND a reference-bearing text block.
        assert len(image_blocks) == 1
        assert any("Region" in t and "North" in t for t in text_blocks), text_blocks

    def test_returns_cross_modal_grounding_vision_analysis(self) -> None:
        esc = _make_escalation()
        out = esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="q", table_resolution=_table_resolution(),
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        va = out.vision_analysis
        assert va is not None
        assert va.mode is VisionMode.CROSS_MODAL
        assert va.cross_modal_family is CrossModalFamily.GROUNDING
        assert va.analysis.startswith("Row North")
        assert [i.retrieval_id for i in va.resolved_images] == ["img-1"]
        assert [r.artifact.label for r in va.resolved_artifacts] == ["Table 3.2"]
        # SINGLE-path output is untouched by grounding.
        assert out.image_analyses == []

    def test_prompt_is_reference_generic_with_constraints(self) -> None:
        esc = _make_escalation()
        esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="q", table_resolution=_table_resolution(),
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        body, _ = _invoke_body_and_model(esc)
        prompt = body["messages"][0]["content"][-1]["text"]
        assert "structured reference (such as a table)" in prompt
        assert "Do NOT invent coordinates" in prompt
        assert "only" in prompt.lower()

    def test_low_confidence_adds_confirmation_note(self) -> None:
        esc = _make_escalation()
        esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="q",
            table_resolution=_table_resolution(confidence=ResolutionConfidence.LOW),
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        body, _ = _invoke_body_and_model(esc)
        prompt = body["messages"][0]["content"][-1]["text"]
        assert "may not be the one the student intended" in prompt

    def test_no_image_resolved_degrades(self) -> None:
        esc = _make_escalation()
        # No image in results and no figure reference -> nothing to ground onto.
        out = esc.escalate_cross_modal_grounding(
            results=[], query="q", table_resolution=_table_resolution(),
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        assert out.escalation_used is False
        assert out.vision_analysis is None
        esc.bedrock_client.invoke_model.assert_not_called()

    def test_vision_failure_degrades(self) -> None:
        esc = _make_escalation()
        esc.bedrock_client.invoke_model.side_effect = Exception("bedrock down")
        out = esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="q", table_resolution=_table_resolution(),
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        assert out.escalation_used is False

    def test_figure_reference_labels_the_image(self) -> None:
        esc = _make_escalation()
        intent = QueryIntent(
            requires_cross_modal_grounding=True,
            figure_references=[FigureReference("table", "3.2"), FigureReference("figure", "4")],
        )
        out = esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="map Table 3.2 onto Figure 4",
            table_resolution=_table_resolution(), query_intent=intent,
        )
        assert out.vision_analysis.reference_mapping[0].reference == "Figure 4"


# ---------------------------------------------------------------------------
# render_artifact — TABLE branch + bounds, plumbing fallback
# ---------------------------------------------------------------------------


class TestRenderArtifact:
    def test_table_renders_headers_and_rows(self) -> None:
        art = GroundedArtifact(
            ElementType.TABLE, "Table 1",
            {"headers": ["A", "B"], "rows": [["1", "2"], ["3", "4"]], "summary": "sum"},
        )
        text = render_artifact(art)
        assert "A | B" in text
        assert "1 | 2" in text and "3 | 4" in text
        assert "sum" in text

    def test_table_row_cap_truncates_with_note(self) -> None:
        rows = [[str(i), "x"] for i in range(60)]
        art = GroundedArtifact(ElementType.TABLE, "T", {"headers": ["i", "v"], "rows": rows})
        text = render_artifact(art)
        assert "truncated" in text.lower()
        # Only the first 50 data rows are rendered.
        assert "49 | x" in text
        assert "50 | x" not in text

    def test_char_budget_truncates(self) -> None:
        big = "z" * 10000
        art = GroundedArtifact(ElementType.TABLE, "T", {"summary": big})
        text = render_artifact(art)
        assert len(text) <= 6000 + len("\n[table truncated — ground only the rows shown above]") + 5
        assert "truncated" in text.lower()

    def test_falls_back_to_raw_content_when_no_structure(self) -> None:
        art = GroundedArtifact(ElementType.TABLE, "T", {"content": "raw table text here"})
        assert "raw table text here" in render_artifact(art)

    def test_generic_fallback_is_plumbing_only_but_does_not_raise(self) -> None:
        # A not-yet-specialized type (FORMULA) renders via the generic key/value
        # dump — proving decoupling, NOT that FORMULA grounding is implemented.
        art = GroundedArtifact(ElementType.FORMULA, "Eq 1", {"latex": "x = y + 1"})
        text = render_artifact(art)
        assert "latex: x = y + 1" in text


# ---------------------------------------------------------------------------
# Abstraction/layering (AC-9, escalation half)
# ---------------------------------------------------------------------------


class TestGroundingAbstraction:
    def test_non_table_artifact_traverses_pipeline_unchanged(self) -> None:
        """A FORMULA GroundedArtifact flows through the SAME message builder +
        VisionAnalysis with no table-specific coupling (FORMULA resolution/render
        remain unbuilt — this asserts decoupling only)."""
        esc = _make_escalation()
        formula_res = GroundingResolution(
            artifact=GroundedArtifact(ElementType.FORMULA, "Equation 3.4", {"latex": "E = mc^2"}),
            ranked_result=None,
            confidence=ResolutionConfidence.MEDIUM,
        )
        out = esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="q", table_resolution=formula_res,
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        assert out.escalation_used is True
        assert out.vision_analysis.mode is VisionMode.CROSS_MODAL
        body, _ = _invoke_body_and_model(esc)
        text_blocks = [b["text"] for b in body["messages"][0]["content"] if b["type"] == "text"]
        # The FORMULA label + fallback-rendered latex reached the vision call.
        assert any("FORMULA — Equation 3.4:" in t for t in text_blocks)
        assert any("E = mc^2" in t for t in text_blocks)
