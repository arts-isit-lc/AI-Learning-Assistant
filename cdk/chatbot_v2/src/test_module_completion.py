"""Tests for ratio-based module completion (the concepts_discussed gate).

The concepts_discussed requirement scales to 50% of the module's topics
(rounded up) with a floor of 1, replacing the old fixed ">= 3" threshold.

state_machine has no psycopg2 dependency, so it imports directly.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

from state_machine import (  # noqa: E402
    check_module_completion,
    create_default_state,
    required_concepts_discussed,
)
from constants.models import (  # noqa: E402
    MIN_ENGAGEMENT_SCORE_FOR_COMPLETION,
    MIN_INTERACTIONS_FOR_COMPLETION,
)


def _concepts(n: int) -> list[str]:
    """Factory: a module with n distinct topic identifiers."""
    return [f"c{i}" for i in range(n)]


def _completable_state(total_topics: int, discussed: int):
    """Build a state that satisfies the interaction + engagement gates so a
    test isolates the concepts_discussed dimension.

    `discussed` distinct topics (drawn from the module's own concepts) are
    marked discussed; the other two completion gates are set exactly at their
    minimums so only the concept count decides the outcome.
    """
    module_concepts = _concepts(total_topics)
    state = create_default_state("sess")
    state.interactions = MIN_INTERACTIONS_FOR_COMPLETION
    state.engagement_score = MIN_ENGAGEMENT_SCORE_FOR_COMPLETION
    state.module_concepts = module_concepts
    state.concepts_discussed = module_concepts[:discussed]
    return state


class TestRequiredConceptsDiscussed:
    """The pure rounding helper: 50% of topics, rounded up, floored at 1."""

    @pytest.mark.parametrize(
        "total, expected",
        [
            (0, 1),  # empty module floors to 1 (stays incompletable)
            (1, 1),  # single topic -> 1
            (2, 1),  # 50% of 2
            (3, 2),  # ceil(1.5)
            (4, 2),  # 50% of 4
            (5, 3),  # ceil(2.5)
            (6, 3),  # 50% of 6
            (7, 4),  # ceil(3.5)
        ],
    )
    def test_half_rounded_up_with_floor(self, total, expected):
        assert required_concepts_discussed(total) == expected


class TestConceptsGateBoundary:
    """check_module_completion flips exactly at the required concept count."""

    @pytest.mark.parametrize("total, required", [(1, 1), (2, 1), (3, 2), (4, 2), (5, 3)])
    def test_just_below_required_is_incomplete(self, total, required):
        state = _completable_state(total_topics=total, discussed=required - 1)
        assert check_module_completion(state) is False

    @pytest.mark.parametrize("total, required", [(1, 1), (2, 1), (3, 2), (4, 2), (5, 3)])
    def test_at_required_completes(self, total, required):
        state = _completable_state(total_topics=total, discussed=required)
        assert check_module_completion(state) is True


class TestSingleTopicModule:
    """The case the change explicitly calls out: one topic requires one discussed."""

    def test_zero_discussed_is_incomplete(self):
        state = _completable_state(total_topics=1, discussed=0)
        assert check_module_completion(state) is False

    def test_one_discussed_completes(self):
        state = _completable_state(total_topics=1, discussed=1)
        assert check_module_completion(state) is True


class TestEmptyModuleEdgeCase:
    def test_empty_module_never_completes_on_concepts(self):
        # No topics -> floor of 1 required, but concepts_discussed can never
        # grow, so the module stays incompletable (matches prior behavior).
        state = _completable_state(total_topics=0, discussed=0)
        assert check_module_completion(state) is False


class TestOtherGatesStillApply:
    """The concept change must not weaken the interaction/engagement gates."""

    def test_interactions_below_min_blocks_completion(self):
        state = _completable_state(total_topics=2, discussed=1)
        state.interactions = MIN_INTERACTIONS_FOR_COMPLETION - 1
        assert check_module_completion(state) is False

    def test_engagement_below_min_blocks_completion(self):
        state = _completable_state(total_topics=2, discussed=1)
        state.engagement_score = MIN_ENGAGEMENT_SCORE_FOR_COMPLETION - 0.01
        assert check_module_completion(state) is False
