"""Tests for the multi-image reasoning data models (VisionAnalysis + friends).

Covers the v1 additions: VisionMode / ResolutionConfidence enums, ResolvedReference,
and VisionAnalysis defaults. The EscalationResult.vision_analysis field (which lives
in reasoning/image_escalation.py) is covered in the escalation tests.
"""

from __future__ import annotations

from .data_models import (
    CrossModalFamily,
    ElementType,
    GroundedArtifact,
    GroundingResolution,
    QueryIntent,
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
        # One structural cross-modal mode (execution), not one per prompt family.
        assert VisionMode.CROSS_MODAL.value == "cross_modal"

    def test_cross_modal_family_values(self) -> None:
        assert CrossModalFamily.GROUNDING.value == "grounding"
        assert CrossModalFamily.EXPLANATION.value == "explanation"

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

    def test_cross_modal_defaults_empty(self) -> None:
        # Additive fields must default so SINGLE/MULTI construction is unaffected.
        va = VisionAnalysis(mode=VisionMode.MULTI, analysis="t", confidence=0.9)
        assert va.resolved_artifacts == []
        assert va.cross_modal_family is None

    def test_cross_modal_family_set(self) -> None:
        va = VisionAnalysis(
            mode=VisionMode.CROSS_MODAL, analysis="t", confidence=0.9,
            cross_modal_family=CrossModalFamily.EXPLANATION,
        )
        assert va.mode is VisionMode.CROSS_MODAL
        assert va.cross_modal_family is CrossModalFamily.EXPLANATION


class TestGroundedArtifact:
    def test_is_pure_no_retrieval_field(self) -> None:
        # The vision-facing artifact must NOT carry a RankedResult (layering
        # invariant: the vision pipeline cannot reach retrieval state).
        art = GroundedArtifact(
            artifact_type=ElementType.TABLE,
            label="Table 3.2",
            structured_content={"headers": ["a"], "rows": [["1"]]},
        )
        field_names = set(vars(art).keys())
        assert field_names == {"artifact_type", "label", "structured_content"}
        assert "result" not in field_names and "ranked_result" not in field_names
        assert art.artifact_type is ElementType.TABLE

    def test_structured_content_defaults_empty(self) -> None:
        art = GroundedArtifact(artifact_type=ElementType.TABLE, label="Table 1")
        assert art.structured_content == {}


class TestGroundingResolution:
    def test_wraps_artifact_and_retrieval(self) -> None:
        table = RankedResult(
            retrieval_id="t1",
            parent_element_id="p1",
            content="Table 3.2 ...",
            element_type=ElementType.TABLE,
            score=0.9,
            cross_encoder_score=0.0,
            metadata_boost=0.0,
        )
        art = GroundedArtifact(ElementType.TABLE, "Table 3.2", {"rows": []})
        res = GroundingResolution(artifact=art, ranked_result=table, confidence=ResolutionConfidence.HIGH)
        assert res.artifact is art
        assert res.ranked_result.retrieval_id == "t1"
        assert res.confidence is ResolutionConfidence.HIGH

    def test_defaults(self) -> None:
        res = GroundingResolution(artifact=GroundedArtifact(ElementType.TABLE, "Table 1"))
        assert res.ranked_result is None
        assert res.confidence is ResolutionConfidence.LOW


class TestQueryIntentGrounding:
    def test_requires_cross_modal_grounding_defaults_false(self) -> None:
        assert QueryIntent().requires_cross_modal_grounding is False
