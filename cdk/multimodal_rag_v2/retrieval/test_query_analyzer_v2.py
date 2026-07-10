"""Tests for QueryAnalyzer V2 features — word boundaries, figure lookup, escalation, week_number.

These tests validate the fixes applied during the V2 switchover:
- Word boundary matching (no false positives from substrings)
- FigureReference extraction (structured type + number)
- Escalation rules (colour, in the diagram, etc.)
- Separate week_number field
- Removed overly broad keywords (solve, compare, values, about)
"""

from __future__ import annotations

import pytest

from ..models.data_models import FigureReference, QueryIntent
from .query_analyzer import QueryAnalyzer


@pytest.fixture
def analyzer() -> QueryAnalyzer:
    """QueryAnalyzer without Bedrock client."""
    return QueryAnalyzer(bedrock_client=None)


# ---------------------------------------------------------------------------
# Word Boundary Tests — prevents false positives from substring matching
# ---------------------------------------------------------------------------


class TestWordBoundaries:
    """Single-word keywords use \\b word boundaries to avoid false positives."""

    def test_graph_does_not_match_paragraph(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Read the next paragraph carefully")
        assert intent.requires_image is False

    def test_graph_matches_standalone(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Look at the graph on page 3")
        assert intent.requires_image is True

    def test_table_does_not_match_timetable(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is the timetable for this semester?")
        assert intent.requires_table is False

    def test_table_matches_standalone(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Show me the table of results")
        assert intent.requires_table is True

    def test_chart_does_not_match_flowchart_as_false_positive(self, analyzer: QueryAnalyzer) -> None:
        # "flowchart" contains "chart" but with word boundaries, "chart" in "flowchart" 
        # should NOT match since there's no word boundary before "chart" in "flowchart"
        intent = analyzer.analyze("Draw a flowchart of the process")
        # "flowchart" does NOT have a word boundary before "chart"
        assert intent.requires_image is False

    def test_figure_matches_standalone(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What does the figure show?")
        assert intent.requires_image is True

    def test_prove_matches_standalone(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Can you prove this theorem?")
        assert intent.requires_formula is True

    def test_prove_does_not_match_improve(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("How can I improve my code?")
        assert intent.requires_formula is False


# ---------------------------------------------------------------------------
# Removed Broad Keywords — verify these no longer trigger
# ---------------------------------------------------------------------------


class TestRemovedBroadKeywords:
    """Keywords like 'solve', 'compare', 'values', 'about', 'map' were removed."""

    def test_solve_does_not_trigger_requires_formula(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Help me solve this problem")
        assert intent.requires_formula is False

    def test_compare_does_not_trigger_requires_table(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Compare mitosis and meiosis")
        assert intent.requires_table is False

    def test_values_does_not_trigger_requires_table(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What are the values of democracy?")
        assert intent.requires_table is False

    def test_about_does_not_trigger_needs_summary(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Tell me about photosynthesis")
        assert intent.needs_summary is False

    def test_map_removed_from_requires_image(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Create a roadmap for the project")
        assert intent.requires_image is False


# ---------------------------------------------------------------------------
# Figure Reference Extraction — structured FigureReference
# ---------------------------------------------------------------------------


class TestFigureReferenceExtraction:
    """FigureReference extracts type and number from queries."""

    def test_figure_1_1_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What colours are in Figure 1.1?")
        assert intent.figure_reference is not None
        assert intent.figure_reference.ref_type == "figure"
        assert intent.figure_reference.number == "1.1"

    def test_fig_2_3_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Explain Fig. 2.3")
        assert intent.figure_reference is not None
        assert intent.figure_reference.ref_type == "figure"
        assert intent.figure_reference.number == "2.3"

    def test_table_4_1_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Dive deeper into Table 4.1")
        assert intent.figure_reference is not None
        assert intent.figure_reference.ref_type == "table"
        assert intent.figure_reference.number == "4.1"

    def test_algorithm_5_2_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What does Algorithm 5.2 do?")
        assert intent.figure_reference is not None
        assert intent.figure_reference.ref_type == "algorithm"
        assert intent.figure_reference.number == "5.2"

    def test_figure_without_decimal(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Explain Figure 3")
        assert intent.figure_reference is not None
        assert intent.figure_reference.ref_type == "figure"
        assert intent.figure_reference.number == "3"

    def test_figure_with_dash_separator(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is in Figure 1-2?")
        assert intent.figure_reference is not None
        assert intent.figure_reference.number == "1-2"

    def test_requires_figure_lookup_set(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Discuss Table 2.1")
        assert intent.requires_figure_lookup is True

    def test_requires_image_set_for_figure_reference(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is Figure 1.1?")
        assert intent.requires_image is True

    def test_no_figure_reference_for_plain_query(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is machine learning?")
        assert intent.figure_reference is None
        assert intent.requires_figure_lookup is False

    def test_case_insensitive_figure_reference(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("explain FIGURE 3.2")
        assert intent.figure_reference is not None
        assert intent.figure_reference.ref_type == "figure"
        assert intent.figure_reference.number == "3.2"


# ---------------------------------------------------------------------------
# Escalation Rules — colour, in the diagram, etc.
# ---------------------------------------------------------------------------


class TestEscalationRules:
    """Escalation triggers for visual-context queries."""

    def test_colour_triggers_escalation(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What colour is the line?")
        assert intent.requires_escalation is True

    def test_color_american_spelling_triggers(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What color represents O(n)?")
        assert intent.requires_escalation is True

    def test_in_the_diagram_triggers(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is shown in the diagram?")
        assert intent.requires_escalation is True

    def test_in_the_graph_triggers(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What values are in the graph?")
        assert intent.requires_escalation is True

    def test_in_the_chart_triggers(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What trend is in the chart?")
        assert intent.requires_escalation is True

    def test_shown_above_triggers(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("As shown above, what happens?")
        assert intent.requires_escalation is True

    def test_shown_below_triggers(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("The result shown below is...")
        assert intent.requires_escalation is True

    def test_what_does_the_does_NOT_trigger(self, analyzer: QueryAnalyzer) -> None:
        """'what does the' was removed — too broad (matches 'what does the Krebs cycle do')."""
        intent = analyzer.analyze("What does the Krebs cycle do?")
        assert intent.requires_escalation is False

    def test_describe_the_does_NOT_trigger(self, analyzer: QueryAnalyzer) -> None:
        """'describe the' was removed — too generic without visual context."""
        intent = analyzer.analyze("Describe the algorithm")
        assert intent.requires_escalation is False


# ---------------------------------------------------------------------------
# Week Number Extraction — separate from lecture_number
# ---------------------------------------------------------------------------


class TestWeekNumberExtraction:
    """week_number is extracted independently from lecture_number."""

    def test_week_5_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What was covered in week 5?")
        assert intent.week_number == 5

    def test_week_with_dash(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("week-3 notes")
        assert intent.week_number == 3

    def test_week_with_underscore(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("week_12 material")
        assert intent.week_number == 12

    def test_week_case_insensitive(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("WEEK 7 topics")
        assert intent.week_number == 7

    def test_week_does_not_set_lecture_number(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What happened in week 5?")
        assert intent.week_number == 5
        assert intent.lecture_number is None

    def test_lecture_does_not_set_week_number(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What was in lecture 3?")
        assert intent.lecture_number == 3
        assert intent.week_number is None

    def test_both_lecture_and_week_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("In week 2, lecture 4 covered...")
        assert intent.week_number == 2
        assert intent.lecture_number == 4

    def test_no_week_returns_none(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is photosynthesis?")
        assert intent.week_number is None


# ---------------------------------------------------------------------------
# Multi-Figure References — multi-image intent vs. comparison intent
# ---------------------------------------------------------------------------


class TestMultiFigureReferences:
    """finditer-based extraction of ALL references + the multi_image/comparison split."""

    def test_two_references_extracted_in_order(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Compare figure 2.1 and figure 4.1")
        assert [(r.ref_type, r.number) for r in intent.figure_references] == [
            ("figure", "2.1"),
            ("figure", "4.1"),
        ]

    def test_single_reference_back_compat(self, analyzer: QueryAnalyzer) -> None:
        """figure_reference stays populated (first ref) for single-reference queries."""
        intent = analyzer.analyze("Explain Figure 2.1")
        assert intent.figure_reference is not None
        assert intent.figure_reference.number == "2.1"
        assert len(intent.figure_references) == 1
        assert intent.requires_multi_image is False
        assert intent.requires_comparison is False

    def test_figure_reference_is_first_of_many(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Compare figure 2.1 and figure 4.1")
        assert intent.figure_reference is not None
        assert intent.figure_reference.number == "2.1"

    def test_comparison_query_sets_both_flags(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze(
            "Compare figure 2.1 and figure 4.1 — which does a better job?"
        )
        assert intent.requires_multi_image is True
        assert intent.requires_comparison is True

    def test_explain_both_is_multi_image_not_comparison(self, analyzer: QueryAnalyzer) -> None:
        """Two references without comparison language: multi-image, NOT comparison."""
        intent = analyzer.analyze("Explain figure 2.1 and figure 4.1")
        assert intent.requires_multi_image is True
        assert intent.requires_comparison is False

    def test_summarize_both_is_multi_image_not_comparison(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Summarize Figure 2.1 and Figure 4.1")
        assert intent.requires_multi_image is True
        assert intent.requires_comparison is False

    def test_versus_triggers_comparison(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Figure 2.1 vs figure 4.1")
        assert intent.requires_multi_image is True
        assert intent.requires_comparison is True

    def test_duplicate_reference_deduped(self, analyzer: QueryAnalyzer) -> None:
        """Same reference twice collapses to one -> not multi-image."""
        intent = analyzer.analyze("Compare figure 2.1 with figure 2.1")
        assert len(intent.figure_references) == 1
        assert intent.requires_multi_image is False
        assert intent.requires_comparison is False

    def test_mixed_types_extracted(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Compare Figure 2.1 and Table 3.2")
        assert [(r.ref_type, r.number) for r in intent.figure_references] == [
            ("figure", "2.1"),
            ("table", "3.2"),
        ]
        assert intent.requires_multi_image is True

    def test_parsed_references_capped(self, analyzer: QueryAnalyzer) -> None:
        """No more than _MAX_PARSED_REFERENCES distinct references are kept."""
        intent = analyzer.analyze(
            "Compare figure 1.1, figure 2.1, figure 3.1, figure 4.1, "
            "figure 5.1, figure 6.1, figure 7.1"
        )
        assert len(intent.figure_references) == QueryAnalyzer._MAX_PARSED_REFERENCES

    def test_comparison_language_without_two_figures_not_comparison(
        self, analyzer: QueryAnalyzer
    ) -> None:
        """'compare' with only one figure reference is not a figure comparison."""
        intent = analyzer.analyze("Compare figure 2.1 to what we learned in lecture 3")
        assert len(intent.figure_references) == 1
        assert intent.requires_multi_image is False
        assert intent.requires_comparison is False

    def test_multi_reference_sets_requires_image_and_lookup(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Compare figure 2.1 and figure 4.1")
        assert intent.requires_image is True
        assert intent.requires_figure_lookup is True

    def test_no_references_leaves_multi_flags_false(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is machine learning?")
        assert intent.figure_references == []
        assert intent.requires_multi_image is False
        assert intent.requires_comparison is False
