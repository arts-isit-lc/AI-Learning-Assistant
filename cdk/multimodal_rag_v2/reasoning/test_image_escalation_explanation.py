"""Tests for the EXPLANATION cross-modal family in ImageEscalation (T3).

Covers escalate_cross_modal(family=EXPLANATION) — one Sonnet 4.5 call co-presenting
a rendered reference + an image with the EXPLANATION prompt — and the grounding
FUNCTIONAL-equivalence guard (grounding still uses the grounding prompt/family; we
do NOT assert byte-for-byte prompt text, so a future grounding-prompt edit won't
break this).
"""

from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import MagicMock

from ..models.data_models import (
    CrossModalFamily,
    ElementType,
    GroundedArtifact,
    GroundingResolution,
    QueryIntent,
    RankedResult,
    ResolutionConfidence,
    VisionMode,
)
from .image_escalation import COMPARISON_VISION_MODEL_ID, ImageEscalation


def _make_escalation() -> ImageEscalation:
    s3_client = MagicMock()
    s3_client.get_object.return_value = {"Body": BytesIO(b"fake-png-bytes")}
    bedrock_client = MagicMock()
    bedrock_client.invoke_model.return_value = {
        "body": BytesIO(
            json.dumps(
                {
                    "content": [{"text": "The table's latencies explain the curve's upward trend."}],
                    "stop_reason": "end_turn",
                }
            ).encode()
        )
    }
    return ImageEscalation(s3_client=s3_client, bedrock_client=bedrock_client, bucket_name="b")


def _image_result() -> RankedResult:
    return RankedResult(
        retrieval_id="img-1", parent_element_id="p", content="A plot",
        element_type=ElementType.IMAGE, score=0.9, cross_encoder_score=0.0,
        metadata_boost=0.0, metadata={}, image_s3_key="images/c/m/fig1.png",
    )


def _table_resolution() -> GroundingResolution:
    return GroundingResolution(
        artifact=GroundedArtifact(
            ElementType.TABLE, "Table 1.1",
            {"headers": ["Region", "Pop"], "rows": [["North", "100"]], "summary": "s"},
        ),
        ranked_result=None,
        confidence=ResolutionConfidence.HIGH,
    )


def _invoke_body_and_model(esc: ImageEscalation):
    kwargs = esc.bedrock_client.invoke_model.call_args.kwargs
    return json.loads(kwargs["body"]), kwargs["modelId"]


def _prompt_text(esc: ImageEscalation) -> str:
    body, _ = _invoke_body_and_model(esc)
    return body["messages"][0]["content"][-1]["text"]


class TestExplanationCall:
    def _run(self, esc):
        return esc.escalate_cross_modal(
            results=[_image_result()],
            query="how does Table 1.1 relate to Figure 1.1?",
            table_resolution=_table_resolution(),
            family=CrossModalFamily.EXPLANATION,
            query_intent=QueryIntent(requires_cross_modal_explanation=True),
        )

    def test_one_call_both_blocks_targets_sonnet(self):
        esc = _make_escalation()
        out = self._run(esc)
        assert out.escalation_used is True
        assert esc.bedrock_client.invoke_model.call_count == 1
        body, model_id = _invoke_body_and_model(esc)
        assert model_id == COMPARISON_VISION_MODEL_ID
        content = body["messages"][0]["content"]
        assert sum(1 for b in content if b["type"] == "image") == 1
        text_blocks = [b["text"] for b in content if b["type"] == "text"]
        assert any("Region" in t and "North" in t for t in text_blocks)

    def test_vision_analysis_mode_and_family(self):
        esc = _make_escalation()
        va = self._run(esc).vision_analysis
        assert va.mode is VisionMode.CROSS_MODAL
        assert va.cross_modal_family is CrossModalFamily.EXPLANATION
        assert [r.artifact.label for r in va.resolved_artifacts] == ["Table 1.1"]
        assert [i.retrieval_id for i in va.resolved_images] == ["img-1"]

    def test_explanation_prompt_structure_and_faithfulness(self):
        esc = _make_escalation()
        self._run(esc)
        prompt = _prompt_text(esc)
        # Relational framing + 4-part structure.
        assert "RELATE to each other" in prompt
        assert "What the reference contains" in prompt
        assert "What the image shows" in prompt
        assert "The relationship between them" in prompt
        # Faithfulness constraints (the observed-failure antidote) + humility.
        assert "Do NOT invent numbers" in prompt
        assert "colors, or curve shapes" in prompt
        assert "cannot be determined" in prompt


class TestGroundingFunctionalEquivalence:
    """Grounding is functionally unchanged by the generalization — same family,
    mode, and prompt SOURCE (the grounding prompt, not the explanation prompt).
    Asserted on properties, NOT byte-for-byte text (§4.4/§11)."""

    def test_wrapper_and_generalized_grounding_match(self):
        esc_a = _make_escalation()
        esc_b = _make_escalation()
        intent = QueryIntent(requires_cross_modal_grounding=True)
        out_wrapper = esc_a.escalate_cross_modal_grounding(
            results=[_image_result()], query="map Table 1.1 onto Figure 1.1",
            table_resolution=_table_resolution(), query_intent=intent,
        )
        out_direct = esc_b.escalate_cross_modal(
            results=[_image_result()], query="map Table 1.1 onto Figure 1.1",
            table_resolution=_table_resolution(), family=CrossModalFamily.GROUNDING,
            query_intent=intent,
        )
        for out in (out_wrapper, out_direct):
            assert out.vision_analysis.mode is VisionMode.CROSS_MODAL
            assert out.vision_analysis.cross_modal_family is CrossModalFamily.GROUNDING
        # Both used the GROUNDING prompt, not the EXPLANATION prompt.
        assert _prompt_text(esc_a) == _prompt_text(esc_b)

    def test_grounding_uses_grounding_prompt_not_explanation(self):
        esc = _make_escalation()
        esc.escalate_cross_modal_grounding(
            results=[_image_result()], query="map Table 1.1 onto Figure 1.1",
            table_resolution=_table_resolution(),
            query_intent=QueryIntent(requires_cross_modal_grounding=True),
        )
        prompt = _prompt_text(esc)
        # Grounding-specific language present; explanation-specific language absent.
        assert "Ground the reference onto the image" in prompt
        assert "Do NOT invent coordinates" in prompt
        assert "RELATE to each other" not in prompt
