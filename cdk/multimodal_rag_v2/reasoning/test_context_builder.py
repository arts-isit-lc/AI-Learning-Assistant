"""Unit tests for ContextBuilder.

Tests cover:
- Sibling expansion (±2 siblings, token budget, empty sibling_ids, no store)
- Clustering (deterministic, same page + same parent)
- Token budget allocation (score-ranked, budget enforcement)
- Prompt formatting (source grouping, page headers)
- build_context orchestration
"""

from __future__ import annotations

import pytest

from ..models.data_models import (
    ContextCluster,
    ElementType,
    RankedResult,
    StructuredContext,
)
from .context_builder import ContextBuilder, SiblingStoreProtocol, _estimate_tokens


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_result(
    retrieval_id: str = "r1",
    parent_element_id: str = "p1",
    content: str = "Sample content text",
    element_type: ElementType = ElementType.TEXT,
    score: float = 0.8,
    cross_encoder_score: float = 0.7,
    metadata_boost: float = 0.1,
    page_num: int | None = 1,
    position_index: int = 0,
    sibling_ids: list[str] | None = None,
    image_s3_key: str | None = None,
) -> RankedResult:
    """Create a RankedResult for testing."""
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id=parent_element_id,
        content=content,
        element_type=element_type,
        score=score,
        cross_encoder_score=cross_encoder_score,
        metadata_boost=metadata_boost,
        metadata={
            "provenance_page_num": page_num,
            "provenance_position_index": position_index,
        },
        image_s3_key=image_s3_key,
        sibling_ids=sibling_ids or [],
    )


class FakeSiblingStore:
    """Fake sibling store that returns pre-configured results by ID."""

    def __init__(self, results: dict[str, RankedResult]) -> None:
        self._results = results

    def get_by_ids(self, retrieval_ids: list[str]) -> list[RankedResult]:
        return [self._results[rid] for rid in retrieval_ids if rid in self._results]


# ---------------------------------------------------------------------------
# Tests: _estimate_tokens
# ---------------------------------------------------------------------------


class TestEstimateTokens:
    def test_empty_string(self) -> None:
        assert _estimate_tokens("") == 0

    def test_known_length(self) -> None:
        # 20 chars / 4 = 5 tokens
        assert _estimate_tokens("a" * 20) == 5

    def test_short_string(self) -> None:
        # 3 chars / 4 = 0 (integer division)
        assert _estimate_tokens("abc") == 0

    def test_typical_content(self) -> None:
        text = "This is a sample passage for testing token estimation."
        expected = len(text) // 4
        assert _estimate_tokens(text) == expected


# ---------------------------------------------------------------------------
# Tests: expand_siblings
# ---------------------------------------------------------------------------


class TestExpandSiblings:
    def test_empty_sibling_ids_returns_result_only(self) -> None:
        """Results with empty sibling_ids are returned without modification."""
        builder = ContextBuilder(sibling_store=FakeSiblingStore({}))
        result = _make_result(sibling_ids=[])
        expanded = builder.expand_siblings(result)
        assert expanded == [result]

    def test_no_sibling_store_returns_result_only(self) -> None:
        """When sibling_store is None, skip expansion."""
        builder = ContextBuilder(sibling_store=None)
        result = _make_result(sibling_ids=["s1", "s2"])
        expanded = builder.expand_siblings(result)
        assert expanded == [result]

    def test_expand_two_siblings_each_direction(self) -> None:
        """Expands up to 2 siblings before and 2 after."""
        siblings = {
            "s1": _make_result(retrieval_id="s1", parent_element_id="p1", content="A", page_num=1, position_index=0),
            "s2": _make_result(retrieval_id="s2", parent_element_id="p1", content="B", page_num=1, position_index=1),
            "s3": _make_result(retrieval_id="s3", parent_element_id="p1", content="D", page_num=1, position_index=3),
            "s4": _make_result(retrieval_id="s4", parent_element_id="p1", content="E", page_num=1, position_index=4),
        }
        store = FakeSiblingStore(siblings)
        builder = ContextBuilder(sibling_store=store)

        result = _make_result(
            retrieval_id="r1",
            parent_element_id="p1",
            content="C",
            page_num=1,
            position_index=2,
            sibling_ids=["s1", "s2", "s3", "s4"],
        )

        expanded = builder.expand_siblings(result)
        ids = [r.retrieval_id for r in expanded]
        # Should include ±2 siblings + original
        assert "r1" in ids
        assert "s1" in ids
        assert "s2" in ids
        assert "s3" in ids
        assert "s4" in ids
        assert len(expanded) == 5

    def test_expansion_stops_at_token_budget(self) -> None:
        """Stop expanding when added tokens > 500."""
        # Create siblings with large content (each ~600 tokens = 2400 chars)
        large_content = "x" * 2400  # 600 tokens
        siblings = {
            "s1": _make_result(retrieval_id="s1", parent_element_id="p1", content=large_content, page_num=1, position_index=0),
            "s2": _make_result(retrieval_id="s2", parent_element_id="p1", content=large_content, page_num=1, position_index=3),
        }
        store = FakeSiblingStore(siblings)
        builder = ContextBuilder(sibling_store=store)

        result = _make_result(
            retrieval_id="r1",
            parent_element_id="p1",
            content="short",
            page_num=1,
            position_index=2,
            sibling_ids=["s1", "s2"],
        )

        expanded = builder.expand_siblings(result, max_expansion_tokens=500)
        # Each sibling is 600 tokens, budget is 500 — neither should be added
        assert len(expanded) == 1
        assert expanded[0].retrieval_id == "r1"

    def test_expansion_preserves_provenance_order(self) -> None:
        """Expanded results are sorted by provenance order."""
        siblings = {
            "s1": _make_result(retrieval_id="s1", parent_element_id="p1", content="Before", page_num=1, position_index=0),
            "s2": _make_result(retrieval_id="s2", parent_element_id="p1", content="After", page_num=1, position_index=4),
        }
        store = FakeSiblingStore(siblings)
        builder = ContextBuilder(sibling_store=store)

        result = _make_result(
            retrieval_id="r1",
            parent_element_id="p1",
            content="Middle",
            page_num=1,
            position_index=2,
            sibling_ids=["s1", "s2"],
        )

        expanded = builder.expand_siblings(result)
        positions = [r.metadata.get("provenance_position_index") for r in expanded]
        assert positions == sorted(positions)

    def test_expansion_max_distance_respected(self) -> None:
        """Only up to max_sibling_distance siblings are taken per direction."""
        siblings = {
            f"s{i}": _make_result(
                retrieval_id=f"s{i}",
                parent_element_id="p1",
                content="x" * 10,
                page_num=1,
                position_index=i,
            )
            for i in range(10)
            if i != 5
        }
        store = FakeSiblingStore(siblings)
        builder = ContextBuilder(sibling_store=store)

        result = _make_result(
            retrieval_id="r1",
            parent_element_id="p1",
            content="center",
            page_num=1,
            position_index=5,
            sibling_ids=[f"s{i}" for i in range(10) if i != 5],
        )

        expanded = builder.expand_siblings(result, max_sibling_distance=2)
        # Should get at most 2 before (s3, s4) and 2 after (s6, s7) + original
        assert len(expanded) <= 5


# ---------------------------------------------------------------------------
# Tests: build_clusters
# ---------------------------------------------------------------------------


class TestBuildClusters:
    def test_empty_results(self) -> None:
        builder = ContextBuilder()
        clusters = builder.build_clusters([])
        assert clusters == []

    def test_single_result_single_cluster(self) -> None:
        builder = ContextBuilder()
        result = _make_result(page_num=1, parent_element_id="p1")
        clusters = builder.build_clusters([result])
        assert len(clusters) == 1
        assert clusters[0].primary_element == result
        assert clusters[0].related_elements == []

    def test_same_page_same_parent_groups_together(self) -> None:
        """Results with same page AND same parent form one cluster."""
        builder = ContextBuilder()
        r1 = _make_result(retrieval_id="r1", page_num=2, parent_element_id="p1", score=0.9)
        r2 = _make_result(retrieval_id="r2", page_num=2, parent_element_id="p1", score=0.7)
        clusters = builder.build_clusters([r1, r2])
        assert len(clusters) == 1
        assert clusters[0].primary_element.retrieval_id == "r1"  # highest score
        assert len(clusters[0].related_elements) == 1

    def test_different_page_different_clusters(self) -> None:
        """Results with different pages form separate clusters."""
        builder = ContextBuilder()
        r1 = _make_result(retrieval_id="r1", page_num=1, parent_element_id="p1")
        r2 = _make_result(retrieval_id="r2", page_num=2, parent_element_id="p1")
        clusters = builder.build_clusters([r1, r2])
        assert len(clusters) == 2

    def test_same_page_different_parent_different_clusters(self) -> None:
        """Same page but different parent form separate clusters."""
        builder = ContextBuilder()
        r1 = _make_result(retrieval_id="r1", page_num=1, parent_element_id="p1")
        r2 = _make_result(retrieval_id="r2", page_num=1, parent_element_id="p2")
        clusters = builder.build_clusters([r1, r2])
        assert len(clusters) == 2

    def test_deterministic_output(self) -> None:
        """Same input produces same output (deterministic)."""
        builder = ContextBuilder()
        results = [
            _make_result(retrieval_id="r1", page_num=1, parent_element_id="p1", score=0.5),
            _make_result(retrieval_id="r2", page_num=2, parent_element_id="p2", score=0.9),
            _make_result(retrieval_id="r3", page_num=1, parent_element_id="p1", score=0.7),
        ]

        clusters_a = builder.build_clusters(results)
        clusters_b = builder.build_clusters(results)

        assert len(clusters_a) == len(clusters_b)
        for ca, cb in zip(clusters_a, clusters_b):
            assert ca.primary_element.retrieval_id == cb.primary_element.retrieval_id
            assert [r.retrieval_id for r in ca.related_elements] == [
                r.retrieval_id for r in cb.related_elements
            ]

    def test_cluster_token_cost_computed(self) -> None:
        """Token cost is computed as sum of token estimates of all elements."""
        builder = ContextBuilder()
        r1 = _make_result(retrieval_id="r1", page_num=1, parent_element_id="p1", content="a" * 100)
        r2 = _make_result(retrieval_id="r2", page_num=1, parent_element_id="p1", content="b" * 200)
        clusters = builder.build_clusters([r1, r2])
        expected_tokens = _estimate_tokens("a" * 100) + _estimate_tokens("b" * 200)
        assert clusters[0].token_cost == expected_tokens

    def test_cluster_order_preserves_first_encounter(self) -> None:
        """Clusters appear in the order their key was first encountered."""
        builder = ContextBuilder()
        results = [
            _make_result(retrieval_id="r1", page_num=3, parent_element_id="p1"),
            _make_result(retrieval_id="r2", page_num=1, parent_element_id="p2"),
            _make_result(retrieval_id="r3", page_num=3, parent_element_id="p1"),
        ]
        clusters = builder.build_clusters(results)
        # First cluster should be page 3/p1 (first encountered)
        assert clusters[0].primary_element.retrieval_id in ("r1", "r3")
        # Second cluster should be page 1/p2
        assert clusters[1].primary_element.retrieval_id == "r2"


# ---------------------------------------------------------------------------
# Tests: allocate_token_budget
# ---------------------------------------------------------------------------


class TestAllocateTokenBudget:
    def test_empty_clusters(self) -> None:
        builder = ContextBuilder()
        result = builder.allocate_token_budget([])
        assert result == []

    def test_all_fit_within_budget(self) -> None:
        """When all clusters fit, all are included."""
        builder = ContextBuilder()
        clusters = [
            ContextCluster(
                primary_element=_make_result(score=0.9, content="short"),
                related_elements=[],
                token_cost=100,
            ),
            ContextCluster(
                primary_element=_make_result(score=0.7, content="short2"),
                related_elements=[],
                token_cost=200,
            ),
        ]
        result = builder.allocate_token_budget(clusters, max_tokens=128_000)
        assert len(result) == 2

    def test_budget_exceeded_excludes_lowest_scored(self) -> None:
        """When budget exceeded, lowest-scored clusters are excluded."""
        builder = ContextBuilder()
        # High-scored cluster
        high = ContextCluster(
            primary_element=_make_result(score=0.9, content="high"),
            related_elements=[],
            token_cost=70_000,
        )
        # Medium-scored cluster
        medium = ContextCluster(
            primary_element=_make_result(score=0.5, content="med"),
            related_elements=[],
            token_cost=70_000,
        )
        # Low-scored cluster
        low = ContextCluster(
            primary_element=_make_result(score=0.2, content="low"),
            related_elements=[],
            token_cost=70_000,
        )
        result = builder.allocate_token_budget([low, medium, high], max_tokens=128_000)
        # Only highest two should fit (70k + 70k = 140k > 128k, so only highest fits?)
        # Actually 70k alone fits. 70k + 70k = 140k > 128k. So only highest fits.
        assert len(result) == 1
        assert result[0].primary_element.score == 0.9

    def test_total_tokens_never_exceeds_budget(self) -> None:
        """Total tokens of selected clusters never exceed max_tokens."""
        builder = ContextBuilder()
        clusters = [
            ContextCluster(
                primary_element=_make_result(score=0.9 - i * 0.1),
                related_elements=[],
                token_cost=30_000,
            )
            for i in range(5)
        ]
        result = builder.allocate_token_budget(clusters, max_tokens=128_000)
        total = sum(c.token_cost for c in result)
        assert total <= 128_000

    def test_ranked_descending_by_score(self) -> None:
        """Clusters are prioritized by highest element score descending."""
        builder = ContextBuilder()
        c1 = ContextCluster(primary_element=_make_result(score=0.3), related_elements=[], token_cost=50_000)
        c2 = ContextCluster(primary_element=_make_result(score=0.8), related_elements=[], token_cost=50_000)
        c3 = ContextCluster(primary_element=_make_result(score=0.6), related_elements=[], token_cost=50_000)

        # Budget allows 2 clusters (100k < 128k)
        result = builder.allocate_token_budget([c1, c2, c3], max_tokens=100_000)
        assert len(result) == 2
        # The two highest-scored should be selected
        scores = [c.primary_element.score for c in result]
        assert 0.8 in scores
        assert 0.6 in scores


# ---------------------------------------------------------------------------
# Tests: format_for_prompt
# ---------------------------------------------------------------------------


class TestFormatForPrompt:
    def test_empty_context(self) -> None:
        builder = ContextBuilder()
        context = StructuredContext()
        result = builder.format_for_prompt(context)
        assert result == ""

    def test_text_passages_included(self) -> None:
        builder = ContextBuilder()
        context = StructuredContext(
            text_passages=[_make_result(content="Hello world", page_num=3)]
        )
        result = builder.format_for_prompt(context)
        assert "Text Passages" in result
        assert "Hello world" in result
        assert "Page 3" in result

    def test_module_context_included(self) -> None:
        builder = ContextBuilder()
        context = StructuredContext(
            text_passages=[_make_result(content="test")]
        )
        result = builder.format_for_prompt(context, module_context="Linear Algebra Week 3")
        assert "Module Context" in result
        assert "Linear Algebra Week 3" in result

    def test_all_types_formatted(self) -> None:
        builder = ContextBuilder()
        context = StructuredContext(
            text_passages=[_make_result(content="text content", element_type=ElementType.TEXT)],
            image_descriptions=[_make_result(content="image desc", element_type=ElementType.IMAGE)],
            formula_results=[_make_result(content="E=mc^2", element_type=ElementType.FORMULA)],
            table_results=[_make_result(content="col1|col2", element_type=ElementType.TABLE)],
        )
        result = builder.format_for_prompt(context)
        assert "Text Passages" in result
        assert "Image Descriptions" in result
        assert "Formulas" in result
        assert "Tables" in result

    def test_page_none_uses_generic_header(self) -> None:
        builder = ContextBuilder()
        context = StructuredContext(
            text_passages=[_make_result(content="no page", page_num=None)]
        )
        result = builder.format_for_prompt(context)
        assert "[Source]" in result


# ---------------------------------------------------------------------------
# Tests: build_context (integration)
# ---------------------------------------------------------------------------


class TestBuildContext:
    def test_basic_build_context(self) -> None:
        """build_context orchestrates expand → cluster → budget → assemble."""
        builder = ContextBuilder()  # No sibling store → expansion skipped
        results = [
            _make_result(retrieval_id="r1", content="Hello", page_num=1, parent_element_id="p1", score=0.9),
            _make_result(retrieval_id="r2", content="World", page_num=2, parent_element_id="p2", score=0.7, element_type=ElementType.IMAGE),
        ]
        context = builder.build_context(results)
        assert len(context.text_passages) == 1
        assert len(context.image_descriptions) == 1

    def test_build_context_with_expansion(self) -> None:
        """build_context expands siblings when store is available."""
        siblings = {
            "s1": _make_result(
                retrieval_id="s1",
                parent_element_id="p1",
                content="sibling",
                page_num=1,
                position_index=0,
            ),
        }
        store = FakeSiblingStore(siblings)
        builder = ContextBuilder(sibling_store=store)

        result = _make_result(
            retrieval_id="r1",
            parent_element_id="p1",
            content="main",
            page_num=1,
            position_index=1,
            sibling_ids=["s1"],
        )
        context = builder.build_context([result])
        # Should include both original and sibling
        assert len(context.text_passages) == 2

    def test_build_context_deduplicates_expanded(self) -> None:
        """build_context deduplicates if same sibling referenced by multiple results."""
        siblings = {
            "s1": _make_result(
                retrieval_id="s1",
                parent_element_id="p1",
                content="shared sibling",
                page_num=1,
                position_index=0,
            ),
        }
        store = FakeSiblingStore(siblings)
        builder = ContextBuilder(sibling_store=store)

        r1 = _make_result(
            retrieval_id="r1", parent_element_id="p1",
            content="first", page_num=1, position_index=1,
            sibling_ids=["s1"],
        )
        r2 = _make_result(
            retrieval_id="r2", parent_element_id="p1",
            content="second", page_num=1, position_index=2,
            sibling_ids=["s1"],
        )
        context = builder.build_context([r1, r2])
        # s1 should appear only once
        ids = [p.retrieval_id for p in context.text_passages]
        assert ids.count("s1") == 1

    def test_build_context_respects_token_budget(self) -> None:
        """build_context applies token budget correctly."""
        builder = ContextBuilder()
        # Create results with large content
        results = [
            _make_result(
                retrieval_id=f"r{i}",
                content="x" * 200_000,  # 50k tokens each
                page_num=i,
                parent_element_id=f"p{i}",
                score=0.9 - i * 0.1,
            )
            for i in range(5)
        ]
        context = builder.build_context(results, max_tokens=128_000)
        # Should fit at most 2 results (50k + 50k = 100k < 128k, 50k+50k+50k = 150k > 128k)
        assert context.token_count <= 128_000
