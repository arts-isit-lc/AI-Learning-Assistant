"""Unit tests for CrossEncoderReranker — cross-encoder reranking with fallback."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from ..models.data_models import ElementType, MergedResult, RankedResult
from .cross_encoder_reranker import CrossEncoderReranker


# ---------------------------------------------------------------------------
# Fixtures / Helpers
# ---------------------------------------------------------------------------


def _make_merged_result(
    retrieval_id: str = "r1",
    content: str = "Some passage text",
    rrf_score: float = 0.5,
    element_type: ElementType = ElementType.TEXT,
    metadata: dict | None = None,
    sibling_ids: list[str] | None = None,
) -> MergedResult:
    """Create a MergedResult for testing."""
    return MergedResult(
        retrieval_id=retrieval_id,
        parent_element_id=f"parent-{retrieval_id}",
        content=content,
        element_type=element_type,
        rrf_score=rrf_score,
        vector_score=rrf_score * 0.8,
        keyword_score=rrf_score * 0.6,
        metadata=metadata or {},
        sibling_ids=sibling_ids or [],
    )


def _make_cross_encoder(scores: list[float]) -> MagicMock:
    """Create a mock cross-encoder that returns specified scores."""
    mock = MagicMock()
    mock.score.return_value = scores
    return mock


@pytest.fixture
def sample_results() -> list[MergedResult]:
    """5 sample merged results with different RRF scores."""
    return [
        _make_merged_result("r1", "passage about physics", rrf_score=0.8),
        _make_merged_result("r2", "passage about chemistry", rrf_score=0.6),
        _make_merged_result("r3", "passage about biology", rrf_score=0.4),
        _make_merged_result("r4", "passage about math", rrf_score=0.3),
        _make_merged_result("r5", "passage about history", rrf_score=0.2),
    ]


# ---------------------------------------------------------------------------
# Tests: Basic reranking (Req 8.3)
# ---------------------------------------------------------------------------


class TestCrossEncoderReranking:
    """Cross-encoder reranking scores and sorts results."""

    def test_rerank_returns_ranked_results_sorted_by_score(
        self, sample_results: list[MergedResult]
    ) -> None:
        """Results are sorted descending by cross_encoder_score."""
        scores = [0.3, 0.9, 0.5, 0.1, 0.7]
        encoder = _make_cross_encoder(scores)
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("test query", sample_results)

        assert len(ranked) == 5
        # Sorted descending: 0.9, 0.7, 0.5, 0.3, 0.1
        assert ranked[0].cross_encoder_score == 0.9
        assert ranked[1].cross_encoder_score == 0.7
        assert ranked[2].cross_encoder_score == 0.5
        assert ranked[3].cross_encoder_score == 0.3
        assert ranked[4].cross_encoder_score == 0.1

    def test_rerank_passes_query_and_passages_to_encoder(
        self, sample_results: list[MergedResult]
    ) -> None:
        """The cross-encoder receives the query and passage content."""
        scores = [0.5] * 5
        encoder = _make_cross_encoder(scores)
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        reranker.rerank("what is gravity?", sample_results)

        encoder.score.assert_called_once_with(
            "what is gravity?",
            [r.content for r in sample_results],
        )

    def test_rerank_returns_top_k_results(
        self, sample_results: list[MergedResult]
    ) -> None:
        """Only top_k results are returned."""
        scores = [0.9, 0.8, 0.7, 0.6, 0.5]
        encoder = _make_cross_encoder(scores)
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("test", sample_results, top_k=3)

        assert len(ranked) == 3
        assert ranked[0].cross_encoder_score == 0.9
        assert ranked[2].cross_encoder_score == 0.7

    def test_rerank_default_top_k_is_30(self) -> None:
        """Default top_k is 30 — all results returned when fewer than 30."""
        results = [_make_merged_result(f"r{i}", f"passage {i}", rrf_score=0.1 * i) for i in range(25)]
        scores = [0.5] * 25
        encoder = _make_cross_encoder(scores)
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("test", results)

        assert len(ranked) == 25

    def test_rerank_with_more_than_30_results(self) -> None:
        """When more than 30 results, only top 30 returned."""
        results = [_make_merged_result(f"r{i}", f"passage {i}", rrf_score=0.01 * i) for i in range(40)]
        scores = [i / 40.0 for i in range(40)]
        encoder = _make_cross_encoder(scores)
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("test", results)

        assert len(ranked) == 30

    def test_rerank_preserves_result_fields(self) -> None:
        """RankedResult carries over fields from MergedResult."""
        result = MergedResult(
            retrieval_id="rid-42",
            parent_element_id="parent-42",
            content="specific content here",
            element_type=ElementType.IMAGE,
            rrf_score=0.6,
            vector_score=0.5,
            keyword_score=0.4,
            metadata={"image_s3_key": "s3://bucket/img.png", "page_num": 3},
            sibling_ids=["sib1", "sib2"],
        )
        encoder = _make_cross_encoder([0.85])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("query", [result])

        assert len(ranked) == 1
        r = ranked[0]
        assert r.retrieval_id == "rid-42"
        assert r.parent_element_id == "parent-42"
        assert r.content == "specific content here"
        assert r.element_type == ElementType.IMAGE
        assert r.cross_encoder_score == 0.85
        assert r.metadata == {"image_s3_key": "s3://bucket/img.png", "page_num": 3}
        assert r.image_s3_key == "s3://bucket/img.png"
        assert r.sibling_ids == ["sib1", "sib2"]

    def test_rerank_sets_score_and_metadata_boost_to_defaults(self) -> None:
        """Score and metadata_boost are left at defaults (set by ProductionRanker)."""
        result = _make_merged_result("r1", "text", rrf_score=0.5)
        encoder = _make_cross_encoder([0.7])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", [result])

        assert ranked[0].score == 0.0
        assert ranked[0].metadata_boost == 0.0


# ---------------------------------------------------------------------------
# Tests: Score clamping (Req 8.3)
# ---------------------------------------------------------------------------


class TestScoreClamping:
    """Scores are clamped to [0, 1] range."""

    def test_score_above_one_clamped_to_one(self) -> None:
        """Score > 1.0 is clamped to 1.0."""
        result = _make_merged_result("r1", "text")
        encoder = _make_cross_encoder([2.5])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", [result])

        assert ranked[0].cross_encoder_score == 1.0

    def test_negative_score_clamped_to_zero(self) -> None:
        """Score < 0.0 is clamped to 0.0."""
        result = _make_merged_result("r1", "text")
        encoder = _make_cross_encoder([-0.5])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", [result])

        assert ranked[0].cross_encoder_score == 0.0

    def test_score_at_boundary_one_unchanged(self) -> None:
        """Score exactly 1.0 stays at 1.0."""
        result = _make_merged_result("r1", "text")
        encoder = _make_cross_encoder([1.0])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", [result])

        assert ranked[0].cross_encoder_score == 1.0

    def test_score_at_boundary_zero_unchanged(self) -> None:
        """Score exactly 0.0 stays at 0.0."""
        result = _make_merged_result("r1", "text")
        encoder = _make_cross_encoder([0.0])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", [result])

        assert ranked[0].cross_encoder_score == 0.0

    def test_mixed_scores_all_clamped(self) -> None:
        """Multiple scores with out-of-range values are all clamped."""
        results = [
            _make_merged_result("r1", "a"),
            _make_merged_result("r2", "b"),
            _make_merged_result("r3", "c"),
        ]
        encoder = _make_cross_encoder([-1.0, 0.5, 3.0])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", results)

        scores = [r.cross_encoder_score for r in ranked]
        assert 1.0 in scores
        assert 0.5 in scores
        assert 0.0 in scores
        # Sorted descending
        assert ranked[0].cross_encoder_score == 1.0
        assert ranked[1].cross_encoder_score == 0.5
        assert ranked[2].cross_encoder_score == 0.0


# ---------------------------------------------------------------------------
# Tests: Unavailability fallback (Req 8.4)
# ---------------------------------------------------------------------------


class TestFallbackBehavior:
    """When cross-encoder is unavailable, RRF score is substituted."""

    def test_none_encoder_uses_rrf_scores(self, sample_results: list[MergedResult]) -> None:
        """No cross-encoder → rrf_score used as cross_encoder_score."""
        reranker = CrossEncoderReranker(cross_encoder=None)

        ranked = reranker.rerank("test query", sample_results)

        assert len(ranked) == 5
        # Sorted by rrf_score descending: 0.8, 0.6, 0.4, 0.3, 0.2
        assert ranked[0].cross_encoder_score == 0.8
        assert ranked[1].cross_encoder_score == 0.6
        assert ranked[2].cross_encoder_score == 0.4
        assert ranked[3].cross_encoder_score == 0.3
        assert ranked[4].cross_encoder_score == 0.2

    def test_encoder_exception_uses_rrf_scores(
        self, sample_results: list[MergedResult]
    ) -> None:
        """Cross-encoder raising exception → fallback to RRF scores."""
        encoder = MagicMock()
        encoder.score.side_effect = RuntimeError("Model endpoint down")
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("test query", sample_results)

        assert len(ranked) == 5
        assert ranked[0].cross_encoder_score == 0.8
        assert ranked[1].cross_encoder_score == 0.6

    def test_fallback_respects_top_k(self) -> None:
        """Fallback path also returns at most top_k results."""
        results = [_make_merged_result(f"r{i}", f"p{i}", rrf_score=0.1 * i) for i in range(10)]
        reranker = CrossEncoderReranker(cross_encoder=None)

        ranked = reranker.rerank("q", results, top_k=3)

        assert len(ranked) == 3

    def test_fallback_sorts_by_rrf_descending(self) -> None:
        """Fallback results are sorted by RRF score descending."""
        results = [
            _make_merged_result("r1", "a", rrf_score=0.2),
            _make_merged_result("r2", "b", rrf_score=0.9),
            _make_merged_result("r3", "c", rrf_score=0.5),
        ]
        reranker = CrossEncoderReranker(cross_encoder=None)

        ranked = reranker.rerank("q", results)

        assert ranked[0].retrieval_id == "r2"
        assert ranked[1].retrieval_id == "r3"
        assert ranked[2].retrieval_id == "r1"

    def test_fallback_clamps_rrf_scores(self) -> None:
        """RRF scores that are out of [0, 1] are clamped in fallback."""
        results = [
            _make_merged_result("r1", "a", rrf_score=1.5),
            _make_merged_result("r2", "b", rrf_score=-0.1),
        ]
        reranker = CrossEncoderReranker(cross_encoder=None)

        ranked = reranker.rerank("q", results)

        assert ranked[0].cross_encoder_score == 1.0
        assert ranked[1].cross_encoder_score == 0.0

    def test_encoder_timeout_exception_triggers_fallback(self) -> None:
        """Timeout-style exceptions also trigger the RRF fallback."""
        encoder = MagicMock()
        encoder.score.side_effect = TimeoutError("Connection timed out")
        reranker = CrossEncoderReranker(cross_encoder=encoder)
        results = [_make_merged_result("r1", "text", rrf_score=0.7)]

        ranked = reranker.rerank("q", results)

        assert len(ranked) == 1
        assert ranked[0].cross_encoder_score == 0.7


# ---------------------------------------------------------------------------
# Tests: Empty inputs
# ---------------------------------------------------------------------------


class TestEmptyInputs:
    """Edge cases with empty inputs."""

    def test_empty_results_returns_empty(self) -> None:
        """Empty results list returns empty list."""
        encoder = _make_cross_encoder([])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("query", [])

        assert ranked == []

    def test_empty_results_with_none_encoder(self) -> None:
        """Empty results with no encoder returns empty list."""
        reranker = CrossEncoderReranker(cross_encoder=None)

        ranked = reranker.rerank("query", [])

        assert ranked == []

    def test_single_result_returns_single(self) -> None:
        """Single result is returned correctly."""
        result = _make_merged_result("r1", "single passage", rrf_score=0.5)
        encoder = _make_cross_encoder([0.8])
        reranker = CrossEncoderReranker(cross_encoder=encoder)

        ranked = reranker.rerank("q", [result])

        assert len(ranked) == 1
        assert ranked[0].cross_encoder_score == 0.8
        assert ranked[0].retrieval_id == "r1"
