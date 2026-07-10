"""Tests for the multi-image reasoning data models (VisionAnalysis + friends).

Covers the v1 additions: VisionMode / ResolutionConfidence enums, ResolvedReference,
and VisionAnalysis defaults. The EscalationResult.vision_analysis field (which lives
in reasoning/image_escalation.py) is covered in the escalation tests.
"""

from __future__ import annotations

from .data_models import (
    ElementType,
    RankedResult,
    ResolutionConfidence,
    ResolvedReference,
    VisionAnalysis,
    VisionMode,
)


def _ranked_image(rid: str = "r1", key: str = "img/1.png") -> RankedResult:
    return RankedResult(
        retrieval_id=rid,
        parent_element_id="p1",
        content="",
        element_type=ElementType.IMAGE,
        score=0.5,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        image_s3_key=key,
    )


class TestVisionEnums:
    def test_vision_mode_values(self) -> None:
        assert VisionMode.SINGLE.value == "single"
        assert VisionMode.MULTI.value == "multi"

    def test_resolution_confidence_values(self) -> None:
        assert {c.value for c in ResolutionConfidence} == {"high", "medium", "low"}


class TestResolvedReference:
    def test_fields(self) -> None:
        rr = ResolvedReference(
            reference="Figure 2.1",
            retrieval_id="r1",
            image_s3_key="img/1.png",
            confidence=ResolutionConfidence.HIGH,
        )
        assert rr.reference == "Figure 2.1"
        assert rr.retrieval_id == "r1"
        assert rr.image_s3_key == "img/1.png"
        assert rr.confidence is ResolutionConfidence.HIGH


class TestVisionAnalysis:
    def test_defaults(self) -> None:
        va = VisionAnalysis(mode=VisionMode.MULTI, analysis="text", confidence=0.9)
        assert va.resolved_images == []
        assert va.reference_mapping == []
        assert va.prompt_intent == "describe_each"

    def test_multi_construction(self) -> None:
        img = _ranked_image()
        va = VisionAnalysis(
            mode=VisionMode.MULTI,
            analysis="comparison text",
            confidence=0.9,
            resolved_images=[img],
            reference_mapping=[
                ResolvedReference("Figure 2.1", "r1", "img/1.png", ResolutionConfidence.HIGH),
            ],
            prompt_intent="compare",
        )
        assert va.mode is VisionMode.MULTI
        assert va.resolved_images[0].retrieval_id == "r1"
        assert va.reference_mapping[0].reference == "Figure 2.1"
        assert va.prompt_intent == "compare"
