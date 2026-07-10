"""Tests for requires_cross_modal_explanation detection in QueryAnalyzer.

Explanation = "how does this reference RELATE to the image". The precision anchor
is a RELATIONAL CUE (not a bare analytical verb), plus the two-signal gate, plus
"not a grounding (placement) query". These pin the full §4.1 example table,
including the deliberate negatives (analytical verb without a cue) and grounding
precedence, and the telemetry cue.
"""

from __future__ import annotations

import pytest

from .query_analyzer import QueryAnalyzer


def _analyze(query: str):
    return QueryAnalyzer(bedrock_client=None).analyze(query)


# (query, should_fire) — the §4.1 table.
_CASES = [
    ("analyze table 1.1 and figure 1.1 and tell me the relationship", True),
    ("analyze the graph in chapter 4 using table 2", True),
    ("explain how table 3 relates to figure 2", True),
    ("summarize figure 4 using table 2", True),
    ("analyze table 3", False),                          # no image, no cue
    ("analyze table 2 and figure 3", False),             # both named but NO relational cue
    ("solve question 5 using table 2", False),           # "using" but no image signal
    ("generate an answer using figure 2", False),        # "using" + image but no reference
    ("explain how table 2 relates to the chapter", False),  # "chapter" is not an image signal
    ("explain the difference between Figure 2 and Figure 3", False),  # no table signal
    ("map the values in table 2 onto figure 4", False),  # placement verb -> grounding, not explanation
]


@pytest.mark.parametrize("query,should_fire", _CASES)
def test_explanation_trigger_table(query: str, should_fire: bool) -> None:
    assert _analyze(query).requires_cross_modal_explanation is should_fire


class TestGroundingPrecedenceAndTelemetry:
    def test_placement_query_is_grounding_not_explanation(self) -> None:
        intent = _analyze("map the values in table 2 onto figure 4")
        assert intent.requires_cross_modal_grounding is True
        assert intent.requires_cross_modal_explanation is False

    def test_relationship_query_is_explanation_not_grounding(self) -> None:
        intent = _analyze("analyze table 1.1 and figure 1.1 and tell me the relationship")
        assert intent.requires_cross_modal_explanation is True
        assert intent.requires_cross_modal_grounding is False

    def test_trigger_cue_recorded_for_telemetry(self) -> None:
        assert _analyze(
            "analyze table 1.1 and figure 1.1 and tell me the relationship"
        ).explanation_trigger_cue == "relationship"
        # The weak "using" cue is recorded so it can be watched in telemetry.
        assert _analyze("summarize figure 4 using table 2").explanation_trigger_cue == "using"

    def test_no_cue_when_not_triggered(self) -> None:
        assert _analyze("analyze table 3").explanation_trigger_cue is None

    def test_existing_flags_unaffected(self) -> None:
        intent = _analyze("analyze table 1.1 and figure 1.1 and tell me the relationship")
        assert intent.requires_table_comparison is False
        assert intent.requires_formula_comparison is False
