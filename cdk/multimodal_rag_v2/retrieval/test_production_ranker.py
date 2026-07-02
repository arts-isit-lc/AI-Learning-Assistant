"""Unit tests for ProductionRanker."""

from __future__ import annotations

import pytest

from ..models.data_models import ElementType, QueryIntent, RankedResult, TypeCaps
from .production_ranker import ProductionRanker


def _make_result(
    retrieval_id: str = "r1",
    element_type: ElementType = ElementType.TEXT,
    cross_encoder_score: float = 0.5,
    metadata: dict | None = None,
) -> RankedResult:
    """Helper to create a RankedResult for testing."""
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id=f"parent-{retrieval_id}",
        content=f"content-{retrieval_id}",
        element_type=element_type,
        score=0.0,
        cross_encoder_score=cross_encoder_score,
        metadata_boost=0.0,
        metadata=metadata or {},
    )


class TestProductionRankerScoring:
    """Tests for score computation logic."""

    def setup_method(self) -> None:
        self.ranker = ProductionRanker()

    def test_empty_results_returns_empty(self) -> None:
        result = self.ranker.rank([])
        assert result == []

    def test_basic_score_computation_no_metadata(self) -> None:
        """Without metadata signals, boost should be 0."""
        results = [_make_result(cross_encoder_score=0.7)]
        ranked = self.ranker.rank(results)
        assert len(ranked) == 1
        assert ranked[0].metadata_boost == 0.0
        assert ranked[0].score == 0.7

    def test_document_summary_boost(self) -> None:
        """is_document_summary=True gives 0.05 boost (applied multiplicatively)."""
        results = [
            _make_result(
                cross_encoder_score=0.5,
                metadata={"is_document_summary": True},
            )
        ]
        ranked = self.ranker.rank(results)
        assert ranked[0].metadata_boost == 0.05
        # Multiplicative (M2): 0.5 * (1 + 0.05) = 0.525
        assert ranked[0].score == pytest.approx(0.525)

    def test_lecture_number_boost(self) -> None:
        """lecture_number presence gives 0.03 boost (applied multiplicatively)."""
        results = [
            _make_result(
                cross_encoder_score=0.5,
                metadata={"lecture_number": 7},
            )
        ]
        ranked = self.ranker.rank(results)
        assert ranked[0].metadata_boost == 0.03
        # Multiplicative (M2): 0.5 * (1 + 0.03) = 0.515
        assert ranked[0].score == pytest.approx(0.515)

    def test_page_num_1_boost(self) -> None:
        """page_num=1 gives 0.02 boost (applied multiplicatively)."""
        results = [
            _make_result(
                cross_encoder_score=0.5,
                metadata={"page_num": 1},
            )
        ]
        ranked = self.ranker.rank(results)
        assert ranked[0].metadata_boost == 0.02
        # Multiplicative (M2): 0.5 * (1 + 0.02) = 0.51
        assert ranked[0].score == pytest.approx(0.51)

    def test_combined_boosts_capped_at_0_1(self) -> None:
        """All boosts combined (0.05 + 0.03 + 0.02 = 0.1) should cap at 0.1."""
        results = [
            _make_result(
                cross_encoder_score=0.5,
                metadata={
                    "is_document_summary": True,
                    "lecture_number": 3,
                    "page_num": 1,
                },
            )
        ]
        ranked = self.ranker.rank(results)
        assert ranked[0].metadata_boost == 0.1
        # Multiplicative (M2): 0.5 * (1 + 0.1) = 0.55
        assert ranked[0].score == pytest.approx(0.55)

    def test_final_score_never_negative(self) -> None:
        """Even with negative cross_encoder_score, final_score is clamped to 0."""
        results = [_make_result(cross_encoder_score=-0.5)]
        ranked = self.ranker.rank(results)
        assert ranked[0].score == 0.0

    def test_final_score_clamped_with_boost(self) -> None:
        """Negative cross_encoder_score + boost still clamped to 0 when sum is negative."""
        results = [
            _make_result(
                cross_encoder_score=-0.2,
                metadata={"page_num": 1},  # 0.02 boost
            )
        ]
        ranked = self.ranker.rank(results)
        # -0.2 * (1 + 0.02) = -0.204, clamped to 0
        assert ranked[0].score == 0.0

    def test_sorting_descending_by_score(self) -> None:
        """Results should be sorted descending by final_score."""
        results = [
            _make_result(retrieval_id="low", cross_encoder_score=0.2),
            _make_result(retrieval_id="high", cross_encoder_score=0.9),
            _make_result(retrieval_id="mid", cross_encoder_score=0.5),
        ]
        ranked = self.ranker.rank(results)
        assert [r.retrieval_id for r in ranked] == ["high", "mid", "low"]

    def test_stable_sort_preserves_order_for_equal_scores(self) -> None:
        """Results with equal scores maintain original order (stable sort)."""
        results = [
            _make_result(retrieval_id="first", cross_encoder_score=0.5),
            _make_result(retrieval_id="second", cross_encoder_score=0.5),
            _make_result(retrieval_id="third", cross_encoder_score=0.5),
        ]
        ranked = self.ranker.rank(results)
        assert [r.retrieval_id for r in ranked] == ["first", "second", "third"]

    def test_metadata_boost_is_never_negative(self) -> None:
        """metadata_boost should always be >= 0 even with weird metadata."""
        results = [_make_result(cross_encoder_score=0.5, metadata={"page_num": 99})]
        ranked = self.ranker.rank(results)
        assert ranked[0].metadata_boost >= 0.0


class TestProductionRankerTypeCaps:
    """Tests for TypeCaps filtering logic."""

    def setup_method(self) -> None:
        self.ranker = ProductionRanker()

    def test_default_caps_applied(self) -> None:
        """Default caps: text=8, image=4, formula=3, table=2."""
        results = [
            _make_result(retrieval_id=f"text-{i}", element_type=ElementType.TEXT, cross_encoder_score=0.9 - i * 0.01)
            for i in range(12)
        ]
        ranked = self.ranker.rank(results)
        assert len(ranked) == 8  # capped at 8 text results

    def test_image_cap_default(self) -> None:
        """Default image cap is 4."""
        results = [
            _make_result(retrieval_id=f"img-{i}", element_type=ElementType.IMAGE, cross_encoder_score=0.9 - i * 0.01)
            for i in range(7)
        ]
        ranked = self.ranker.rank(results)
        assert len(ranked) == 4

    def test_formula_cap_default(self) -> None:
        """Default formula cap is 3."""
        results = [
            _make_result(retrieval_id=f"formula-{i}", element_type=ElementType.FORMULA, cross_encoder_score=0.9 - i * 0.01)
            for i in range(6)
        ]
        ranked = self.ranker.rank(results)
        assert len(ranked) == 3

    def test_table_cap_default(self) -> None:
        """Default table cap is 2."""
        results = [
            _make_result(retrieval_id=f"table-{i}", element_type=ElementType.TABLE, cross_encoder_score=0.9 - i * 0.01)
            for i in range(5)
        ]
        ranked = self.ranker.rank(results)
        assert len(ranked) == 2

    def test_mixed_types_respect_individual_caps(self) -> None:
        """Each type cap is enforced independently."""
        results = [
            _make_result(retrieval_id="text-1", element_type=ElementType.TEXT, cross_encoder_score=0.95),
            _make_result(retrieval_id="img-1", element_type=ElementType.IMAGE, cross_encoder_score=0.94),
            _make_result(retrieval_id="text-2", element_type=ElementType.TEXT, cross_encoder_score=0.93),
            _make_result(retrieval_id="formula-1", element_type=ElementType.FORMULA, cross_encoder_score=0.92),
            _make_result(retrieval_id="table-1", element_type=ElementType.TABLE, cross_encoder_score=0.91),
        ]
        ranked = self.ranker.rank(results)
        # All within caps, so all 5 should be returned
        assert len(ranked) == 5

    def test_custom_type_caps(self) -> None:
        """Custom TypeCaps override defaults."""
        results = [
            _make_result(retrieval_id=f"text-{i}", element_type=ElementType.TEXT, cross_encoder_score=0.9 - i * 0.01)
            for i in range(10)
        ]
        custom_caps = TypeCaps(max_text=3, max_image=2, max_formula=1, max_table=1)
        ranked = self.ranker.rank(results, type_caps=custom_caps)
        assert len(ranked) == 3

    def test_query_intent_adjusts_image_cap(self) -> None:
        """requires_image increases max_image from 4 to 6."""
        results = [
            _make_result(retrieval_id=f"img-{i}", element_type=ElementType.IMAGE, cross_encoder_score=0.9 - i * 0.01)
            for i in range(8)
        ]
        intent = QueryIntent(requires_image=True)
        ranked = self.ranker.rank(results, query_intent=intent)
        assert len(ranked) == 6

    def test_query_intent_adjusts_formula_cap(self) -> None:
        """requires_formula increases max_formula from 3 to 5."""
        results = [
            _make_result(retrieval_id=f"formula-{i}", element_type=ElementType.FORMULA, cross_encoder_score=0.9 - i * 0.01)
            for i in range(7)
        ]
        intent = QueryIntent(requires_formula=True)
        ranked = self.ranker.rank(results, query_intent=intent)
        assert len(ranked) == 5

    def test_query_intent_adjusts_table_cap(self) -> None:
        """requires_table increases max_table from 2 to 4."""
        results = [
            _make_result(retrieval_id=f"table-{i}", element_type=ElementType.TABLE, cross_encoder_score=0.9 - i * 0.01)
            for i in range(6)
        ]
        intent = QueryIntent(requires_table=True)
        ranked = self.ranker.rank(results, query_intent=intent)
        assert len(ranked) == 4

    def test_query_intent_combined_adjustments(self) -> None:
        """Multiple intent flags adjust multiple caps simultaneously."""
        results = (
            [_make_result(retrieval_id=f"img-{i}", element_type=ElementType.IMAGE, cross_encoder_score=0.9 - i * 0.01) for i in range(8)]
            + [_make_result(retrieval_id=f"formula-{i}", element_type=ElementType.FORMULA, cross_encoder_score=0.8 - i * 0.01) for i in range(7)]
        )
        intent = QueryIntent(requires_image=True, requires_formula=True)
        ranked = self.ranker.rank(results, query_intent=intent)
        images = [r for r in ranked if r.element_type == ElementType.IMAGE]
        formulas = [r for r in ranked if r.element_type == ElementType.FORMULA]
        assert len(images) == 6
        assert len(formulas) == 5

    def test_type_caps_preserves_score_order(self) -> None:
        """TypeCaps keeps highest-scoring items per type."""
        results = [
            _make_result(retrieval_id="text-high", element_type=ElementType.TEXT, cross_encoder_score=0.9),
            _make_result(retrieval_id="text-low", element_type=ElementType.TEXT, cross_encoder_score=0.1),
        ]
        caps = TypeCaps(max_text=1, max_image=4, max_formula=3, max_table=2)
        ranked = self.ranker.rank(results, type_caps=caps)
        assert len(ranked) == 1
        assert ranked[0].retrieval_id == "text-high"


class TestProductionRankerDeterminism:
    """Tests for deterministic behavior."""

    def setup_method(self) -> None:
        self.ranker = ProductionRanker()

    def test_identical_inputs_produce_identical_outputs(self) -> None:
        """Same inputs always produce same outputs (Req 8.8)."""
        results = [
            _make_result(retrieval_id="a", cross_encoder_score=0.8, metadata={"page_num": 1}),
            _make_result(retrieval_id="b", cross_encoder_score=0.6, metadata={"is_document_summary": True}),
            _make_result(retrieval_id="c", cross_encoder_score=0.7),
        ]
        # Run multiple times
        for _ in range(10):
            ranked = self.ranker.rank(
                [
                    _make_result(retrieval_id="a", cross_encoder_score=0.8, metadata={"page_num": 1}),
                    _make_result(retrieval_id="b", cross_encoder_score=0.6, metadata={"is_document_summary": True}),
                    _make_result(retrieval_id="c", cross_encoder_score=0.7),
                ]
            )
            assert [r.retrieval_id for r in ranked] == ["a", "c", "b"]

    def test_no_randomness_in_output(self) -> None:
        """Output order must be the same across multiple invocations."""
        base_results = [
            _make_result(retrieval_id=f"r{i}", element_type=ElementType.TEXT, cross_encoder_score=0.5)
            for i in range(5)
        ]
        first_run = self.ranker.rank(
            [_make_result(retrieval_id=f"r{i}", element_type=ElementType.TEXT, cross_encoder_score=0.5) for i in range(5)]
        )
        for _ in range(20):
            run = self.ranker.rank(
                [_make_result(retrieval_id=f"r{i}", element_type=ElementType.TEXT, cross_encoder_score=0.5) for i in range(5)]
            )
            assert [r.retrieval_id for r in run] == [r.retrieval_id for r in first_run]
