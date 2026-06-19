"""Unit tests for ImageEscalation."""

from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from ..models.data_models import ElementType, ImageAnalysis, Provenance, RankedResult
from .image_escalation import EscalationResult, ImageEscalation


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_ranked_result(
    score: float = 0.9,
    image_s3_key: str | None = None,
    retrieval_id: str = "r1",
) -> RankedResult:
    """Helper to build a RankedResult for tests."""
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id="elem-1",
        content="test content",
        element_type=ElementType.IMAGE,
        score=score,
        cross_encoder_score=score - 0.05,
        metadata_boost=0.05,
        image_s3_key=image_s3_key,
    )


def _make_s3_client(image_bytes: bytes = b"fake-image-data") -> MagicMock:
    """Create a mock S3 client that returns image bytes."""
    s3 = MagicMock()
    body_mock = MagicMock()
    body_mock.read.return_value = image_bytes
    s3.get_object.return_value = {"Body": body_mock}
    return s3


def _make_bedrock_client(
    analysis_text: str = "This is a diagram showing...",
    confidence_stop: str = "end_turn",
) -> MagicMock:
    """Create a mock Bedrock client that returns analysis."""
    bedrock = MagicMock()
    response_body = {
        "content": [{"text": analysis_text}],
        "stop_reason": confidence_stop,
    }
    body_stream = MagicMock()
    body_stream.read.return_value = json.dumps(response_body).encode()
    bedrock.invoke_model.return_value = {"body": body_stream}
    return bedrock


# ---------------------------------------------------------------------------
# Tests: No images available
# ---------------------------------------------------------------------------


class TestNoImagesAvailable:
    """Tests for when no images are available for escalation."""

    def test_empty_results_returns_escalation_unused(self):
        escalation = ImageEscalation(
            s3_client=MagicMock(),
            bedrock_client=MagicMock(),
            bucket_name="test-bucket",
        )
        result = escalation.escalate([], "show me the diagram")

        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_results_without_image_keys_returns_escalation_unused(self):
        results = [
            _make_ranked_result(score=0.9, image_s3_key=None),
            _make_ranked_result(score=0.8, image_s3_key=None, retrieval_id="r2"),
        ]
        escalation = ImageEscalation(
            s3_client=MagicMock(),
            bedrock_client=MagicMock(),
            bucket_name="test-bucket",
        )
        result = escalation.escalate(results, "show me the diagram")

        assert result.escalation_used is False
        assert result.image_analyses == []


# ---------------------------------------------------------------------------
# Tests: Successful escalation
# ---------------------------------------------------------------------------


class TestSuccessfulEscalation:
    """Tests for successful image escalation."""

    def test_single_image_analysis(self):
        results = [
            _make_ranked_result(score=0.9, image_s3_key="images/diagram1.png"),
        ]
        s3 = _make_s3_client()
        bedrock = _make_bedrock_client(analysis_text="A neural network architecture diagram")

        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "show me the neural network")

        assert result.escalation_used is True
        assert len(result.image_analyses) == 1
        assert result.image_analyses[0].image_s3_key == "images/diagram1.png"
        assert result.image_analyses[0].analysis == "A neural network architecture diagram"
        assert result.image_analyses[0].confidence == 0.9

    def test_top_2_selected_by_score(self):
        results = [
            _make_ranked_result(score=0.5, image_s3_key="images/low.png", retrieval_id="r1"),
            _make_ranked_result(score=0.95, image_s3_key="images/high.png", retrieval_id="r2"),
            _make_ranked_result(score=0.7, image_s3_key="images/mid.png", retrieval_id="r3"),
        ]
        s3 = _make_s3_client()
        bedrock = _make_bedrock_client()

        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "look at the figures")

        assert result.escalation_used is True
        assert len(result.image_analyses) == 2
        # Top 2 by score are high (0.95) and mid (0.7)
        keys = [a.image_s3_key for a in result.image_analyses]
        assert "images/high.png" in keys
        assert "images/mid.png" in keys
        assert "images/low.png" not in keys

    def test_filters_only_non_null_image_keys(self):
        results = [
            _make_ranked_result(score=0.95, image_s3_key=None, retrieval_id="r1"),
            _make_ranked_result(score=0.9, image_s3_key="images/valid.png", retrieval_id="r2"),
            _make_ranked_result(score=0.85, image_s3_key=None, retrieval_id="r3"),
            _make_ranked_result(score=0.3, image_s3_key="images/low.png", retrieval_id="r4"),
        ]
        s3 = _make_s3_client()
        bedrock = _make_bedrock_client()

        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "show me the chart")

        assert result.escalation_used is True
        assert len(result.image_analyses) == 2
        keys = [a.image_s3_key for a in result.image_analyses]
        assert "images/valid.png" in keys
        assert "images/low.png" in keys

    def test_confidence_based_on_stop_reason(self):
        bedrock = _make_bedrock_client(confidence_stop="max_tokens")
        s3 = _make_s3_client()
        results = [_make_ranked_result(score=0.9, image_s3_key="img.png")]

        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "look at this")

        assert result.image_analyses[0].confidence == 0.7


# ---------------------------------------------------------------------------
# Tests: S3 fetch failures
# ---------------------------------------------------------------------------


class TestS3FetchFailures:
    """Tests for S3 fetch failure handling."""

    def test_s3_failure_skips_image(self):
        s3 = MagicMock()
        s3.get_object.side_effect = Exception("S3 connection timeout")
        bedrock = _make_bedrock_client()

        results = [_make_ranked_result(score=0.9, image_s3_key="images/fail.png")]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "show me the diagram")

        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_s3_failure_continues_with_next_image(self):
        s3 = MagicMock()
        # First call fails, second succeeds
        body_mock = MagicMock()
        body_mock.read.return_value = b"image-bytes"
        s3.get_object.side_effect = [
            Exception("Timeout"),
            {"Body": body_mock},
        ]
        bedrock = _make_bedrock_client(analysis_text="Second image analysis")

        results = [
            _make_ranked_result(score=0.95, image_s3_key="images/fail.png", retrieval_id="r1"),
            _make_ranked_result(score=0.9, image_s3_key="images/ok.png", retrieval_id="r2"),
        ]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "in the figure")

        assert result.escalation_used is True
        assert len(result.image_analyses) == 1
        assert result.image_analyses[0].image_s3_key == "images/ok.png"

    def test_all_s3_failures_returns_escalation_unused(self):
        s3 = MagicMock()
        s3.get_object.side_effect = Exception("S3 unavailable")
        bedrock = _make_bedrock_client()

        results = [
            _make_ranked_result(score=0.95, image_s3_key="img1.png", retrieval_id="r1"),
            _make_ranked_result(score=0.9, image_s3_key="img2.png", retrieval_id="r2"),
        ]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "show me")

        assert result.escalation_used is False
        assert result.image_analyses == []


# ---------------------------------------------------------------------------
# Tests: Vision LLM failures
# ---------------------------------------------------------------------------


class TestVisionLLMFailures:
    """Tests for vision LLM failure handling."""

    def test_vision_failure_skips_image(self):
        s3 = _make_s3_client()
        bedrock = MagicMock()
        bedrock.invoke_model.side_effect = Exception("Model unavailable")

        results = [_make_ranked_result(score=0.9, image_s3_key="img.png")]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "this diagram")

        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_vision_failure_continues_with_next_image(self):
        s3 = _make_s3_client()
        bedrock = MagicMock()

        # First invoke fails, second succeeds
        success_body = MagicMock()
        success_body.read.return_value = json.dumps(
            {"content": [{"text": "Analysis of second image"}], "stop_reason": "end_turn"}
        ).encode()

        bedrock.invoke_model.side_effect = [
            Exception("Throttling"),
            {"body": success_body},
        ]

        results = [
            _make_ranked_result(score=0.95, image_s3_key="img1.png", retrieval_id="r1"),
            _make_ranked_result(score=0.9, image_s3_key="img2.png", retrieval_id="r2"),
        ]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "look at figures")

        assert result.escalation_used is True
        assert len(result.image_analyses) == 1
        assert result.image_analyses[0].image_s3_key == "img2.png"

    def test_all_vision_failures_returns_escalation_unused(self):
        s3 = _make_s3_client()
        bedrock = MagicMock()
        bedrock.invoke_model.side_effect = Exception("Model error")

        results = [
            _make_ranked_result(score=0.95, image_s3_key="a.png", retrieval_id="r1"),
            _make_ranked_result(score=0.9, image_s3_key="b.png", retrieval_id="r2"),
        ]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=bedrock, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "show me")

        assert result.escalation_used is False
        assert result.image_analyses == []


# ---------------------------------------------------------------------------
# Tests: Never raises unhandled exceptions
# ---------------------------------------------------------------------------


class TestNoUnhandledExceptions:
    """Tests that ImageEscalation never raises unhandled exceptions."""

    def test_none_s3_client_does_not_raise(self):
        results = [_make_ranked_result(score=0.9, image_s3_key="img.png")]
        escalation = ImageEscalation(
            s3_client=None, bedrock_client=MagicMock(), bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "query")

        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_none_bedrock_client_does_not_raise(self):
        s3 = _make_s3_client()
        results = [_make_ranked_result(score=0.9, image_s3_key="img.png")]
        escalation = ImageEscalation(
            s3_client=s3, bedrock_client=None, bucket_name="test-bucket"
        )
        result = escalation.escalate(results, "query")

        assert result.escalation_used is False
        assert result.image_analyses == []


# ---------------------------------------------------------------------------
# Tests: Media type detection
# ---------------------------------------------------------------------------


class TestMediaTypeDetection:
    """Tests for _get_media_type static method."""

    @pytest.mark.parametrize(
        "key,expected",
        [
            ("images/photo.png", "image/png"),
            ("images/photo.PNG", "image/png"),
            ("images/photo.jpg", "image/jpeg"),
            ("images/photo.jpeg", "image/jpeg"),
            ("images/photo.gif", "image/gif"),
            ("images/photo.webp", "image/webp"),
            ("images/photo.tiff", "image/tiff"),
            ("images/photo.tif", "image/tiff"),
            ("images/photo.bmp", "image/bmp"),
            ("images/photo.unknown", "image/png"),
            ("images/no_extension", "image/png"),
        ],
    )
    def test_media_type_from_extension(self, key: str, expected: str):
        assert ImageEscalation._get_media_type(key) == expected


# ---------------------------------------------------------------------------
# Tests: EscalationResult dataclass
# ---------------------------------------------------------------------------


class TestEscalationResult:
    """Tests for the EscalationResult dataclass."""

    def test_default_values(self):
        result = EscalationResult(escalation_used=False)
        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_with_analyses(self):
        analyses = [
            ImageAnalysis(image_s3_key="img.png", analysis="test", confidence=0.9)
        ]
        result = EscalationResult(escalation_used=True, image_analyses=analyses)
        assert result.escalation_used is True
        assert len(result.image_analyses) == 1
