"""Unit tests for QueryAnalyzer — two-tier query classification."""

from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import MagicMock

import pytest

from ..models.data_models import QueryIntent
from .query_analyzer import QueryAnalyzer


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def analyzer() -> QueryAnalyzer:
    """QueryAnalyzer without Bedrock client (Haiku fallback returns default)."""
    return QueryAnalyzer(bedrock_client=None)


def _make_bedrock_response(classification: dict) -> MagicMock:
    """Create a mock Bedrock invoke_model response."""
    response_body = {
        "content": [{"type": "text", "text": json.dumps(classification)}],
        "stop_reason": "end_turn",
    }
    mock_response = MagicMock()
    mock_response["body"].read.return_value = json.dumps(response_body).encode()
    return mock_response


def _make_bedrock_client(classification: dict) -> MagicMock:
    """Create a mock Bedrock client that returns a classification response."""
    client = MagicMock()
    response_body = {
        "content": [{"type": "text", "text": json.dumps(classification)}],
        "stop_reason": "end_turn",
    }
    body_stream = BytesIO(json.dumps(response_body).encode())
    client.invoke_model.return_value = {"body": body_stream}
    return client


# ---------------------------------------------------------------------------
# Tests: Rule-based classification (Req 7.1, 7.2)
# ---------------------------------------------------------------------------


class TestRuleBasedClassification:
    """Rule-based classification fires on keyword substring match."""

    def test_requires_image_fires_on_figure(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Show me the figure from page 5")
        assert intent.requires_image is True

    def test_requires_image_fires_on_diagram(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Can you explain this diagram?")
        assert intent.requires_image is True

    def test_requires_image_fires_on_chart(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What does the chart show?")
        assert intent.requires_image is True

    def test_requires_image_fires_on_visual(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("I need a visual explanation")
        assert intent.requires_image is True

    def test_requires_formula_fires_on_equation(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is the equation for gravity?")
        assert intent.requires_formula is True

    def test_requires_formula_fires_on_derive(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("How do you derive the velocity formula?")
        assert intent.requires_formula is True

    def test_requires_formula_fires_on_solve(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Can you solve this problem?")
        assert intent.requires_formula is True

    def test_requires_formula_fires_on_calculate(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("How to calculate the area?")
        assert intent.requires_formula is True

    def test_requires_table_fires_on_data(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What data supports this conclusion?")
        assert intent.requires_table is True

    def test_requires_table_fires_on_compare(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Compare the two algorithms")
        assert intent.requires_table is True

    def test_requires_table_fires_on_statistics(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What are the statistics for this experiment?")
        assert intent.requires_table is True

    def test_needs_summary_fires_on_lecture(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What did we cover in lecture 5?")
        assert intent.needs_summary is True

    def test_needs_summary_fires_on_overview(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Give me an overview of the module")
        assert intent.needs_summary is True

    def test_needs_summary_fires_on_topics(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What topics were covered?")
        assert intent.needs_summary is True

    def test_requires_escalation_fires_on_show_me(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Show me the network architecture")
        assert intent.requires_escalation is True

    def test_requires_escalation_fires_on_look_at(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Look at this code snippet")
        assert intent.requires_escalation is True

    def test_requires_escalation_fires_on_in_the_figure(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is shown in the figure on page 3?")
        assert intent.requires_escalation is True

    def test_requires_escalation_fires_on_this_diagram(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Explain this diagram please")
        assert intent.requires_escalation is True

    def test_case_insensitive_matching(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("SHOW ME THE DIAGRAM")
        assert intent.requires_escalation is True
        assert intent.requires_image is True

    def test_multiple_rules_fire_simultaneously(self, analyzer: QueryAnalyzer) -> None:
        """Multiple rules can fire at once (e.g. 'show me the diagram')."""
        intent = analyzer.analyze("show me the diagram with data")
        assert intent.requires_escalation is True
        assert intent.requires_image is True
        assert intent.requires_table is True

    def test_no_llm_invoked_when_rules_fire(self) -> None:
        """When rules fire, Bedrock client is never called."""
        mock_client = MagicMock()
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        analyzer.analyze("Explain the diagram")
        mock_client.invoke_model.assert_not_called()

    def test_returns_immediately_on_rule_match(self, analyzer: QueryAnalyzer) -> None:
        """Rules fire and return valid QueryIntent structure."""
        intent = analyzer.analyze("What formula is used?")
        assert isinstance(intent, QueryIntent)
        assert intent.requires_formula is True
        # Other unmatched flags should be False
        assert intent.requires_image is False
        assert intent.requires_table is False
        assert intent.requires_escalation is False


# ---------------------------------------------------------------------------
# Tests: Haiku fallback (Req 7.3)
# ---------------------------------------------------------------------------


class TestHaikuFallback:
    """Haiku fallback invoked when no rules fire."""

    def test_haiku_invoked_when_no_rules_fire(self) -> None:
        """Ambiguous query with no keyword matches triggers Haiku."""
        classification = {
            "needs_summary": False,
            "requires_image": True,
            "requires_formula": False,
            "requires_table": False,
            "requires_escalation": False,
        }
        mock_client = _make_bedrock_client(classification)
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        intent = analyzer.analyze("How does photosynthesis work?")
        mock_client.invoke_model.assert_called_once()
        assert intent.requires_image is True

    def test_haiku_returns_all_flags(self) -> None:
        """Haiku can set multiple flags."""
        classification = {
            "needs_summary": True,
            "requires_image": False,
            "requires_formula": True,
            "requires_table": False,
            "requires_escalation": False,
        }
        mock_client = _make_bedrock_client(classification)
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        intent = analyzer.analyze("How does photosynthesis work?")
        assert intent.needs_summary is True
        assert intent.requires_formula is True
        assert intent.requires_image is False

    def test_haiku_failure_returns_default_intent(self) -> None:
        """On Haiku failure, return default QueryIntent (all flags false)."""
        mock_client = MagicMock()
        mock_client.invoke_model.side_effect = Exception("Bedrock unavailable")
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        intent = analyzer.analyze("How does photosynthesis work?")
        assert intent.needs_summary is False
        assert intent.requires_image is False
        assert intent.requires_formula is False
        assert intent.requires_table is False
        assert intent.requires_escalation is False

    def test_no_bedrock_client_returns_default_intent(self) -> None:
        """Without a bedrock client, fallback returns default QueryIntent."""
        analyzer = QueryAnalyzer(bedrock_client=None)

        intent = analyzer.analyze("How does photosynthesis work?")
        assert intent.needs_summary is False
        assert intent.requires_image is False
        assert intent.requires_formula is False
        assert intent.requires_table is False
        assert intent.requires_escalation is False

    def test_haiku_malformed_json_returns_default(self) -> None:
        """If Haiku returns invalid JSON, return default intent."""
        mock_client = MagicMock()
        response_body = {
            "content": [{"type": "text", "text": "not valid json at all"}],
            "stop_reason": "end_turn",
        }
        body_stream = BytesIO(json.dumps(response_body).encode())
        mock_client.invoke_model.return_value = {"body": body_stream}
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        intent = analyzer.analyze("How does photosynthesis work?")
        assert intent == QueryIntent()

    def test_haiku_markdown_wrapped_json_parsed(self) -> None:
        """Haiku sometimes wraps JSON in markdown code fences."""
        classification = {
            "needs_summary": False,
            "requires_image": False,
            "requires_formula": False,
            "requires_table": True,
            "requires_escalation": False,
        }
        json_text = f"```json\n{json.dumps(classification)}\n```"
        mock_client = MagicMock()
        response_body = {
            "content": [{"type": "text", "text": json_text}],
            "stop_reason": "end_turn",
        }
        body_stream = BytesIO(json.dumps(response_body).encode())
        mock_client.invoke_model.return_value = {"body": body_stream}
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        intent = analyzer.analyze("How does photosynthesis work?")
        assert intent.requires_table is True


# ---------------------------------------------------------------------------
# Tests: Lecture number extraction (Req 7.7)
# ---------------------------------------------------------------------------


class TestLectureNumberExtraction:
    """Lecture number extraction via regex."""

    def test_lecture_with_space(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What was covered in lecture 7?")
        assert intent.lecture_number == 7

    def test_lecture_with_underscore(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("Topics from lecture_12")
        assert intent.lecture_number == 12

    def test_lecture_with_dash(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("lecture-3 overview")
        assert intent.lecture_number == 3

    def test_lec_abbreviation(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is in lec 5?")
        assert intent.lecture_number == 5

    def test_lec_abbreviation_with_dash(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("lec-9 content")
        assert intent.lecture_number == 9

    def test_lec_no_separator(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("lec03 material")
        assert intent.lecture_number == 3

    def test_case_insensitive_extraction(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("LECTURE 10 topics")
        assert intent.lecture_number == 10

    def test_no_lecture_number_returns_none(self, analyzer: QueryAnalyzer) -> None:
        intent = analyzer.analyze("What is machine learning?")
        assert intent.lecture_number is None

    def test_lecture_number_extracted_with_rule_match(self, analyzer: QueryAnalyzer) -> None:
        """Lecture number extraction happens regardless of rule-based path."""
        intent = analyzer.analyze("What topics were covered in lecture 8?")
        assert intent.needs_summary is True
        assert intent.lecture_number == 8

    def test_lecture_number_extracted_with_haiku_fallback(self) -> None:
        """Lecture number extraction happens regardless of Haiku path."""
        classification = {
            "needs_summary": False,
            "requires_image": False,
            "requires_formula": False,
            "requires_table": False,
            "requires_escalation": False,
        }
        mock_client = _make_bedrock_client(classification)
        analyzer = QueryAnalyzer(bedrock_client=mock_client)

        # "How does lecture 4 relate to..." - no keywords match standard rules
        # Actually "lecture" matches needs_summary, let's use a different query
        # We need a query with lecture number but no rule keywords
        # "lec 4" by itself doesn't have the standard keywords except "lecture/lec"
        # actually "lecture" is in needs_summary keywords, so let's test differently
        # Let's just verify extraction works on the haiku path
        intent = analyzer.analyze("Tell me lec 4 prerequisites")
        # "lec" is not in any keyword set directly — wait, but "lecture" is in needs_summary
        # Let's confirm: needs_summary has "lecture" — but "lec" is not the same as "lecture"
        # "lec 4 prerequisites" — "lec" is not in any keyword set (keywords are exact substrings)
        # "lecture" would match but "lec" won't since we check "lec" in "tell me lec 4 prerequisites"
        # Actually "lec" IS a substring match — wait no, the keyword is "lecture" not "lec"
        # Looking at RULES: needs_summary has "lecture" — "lec" is NOT "lecture"
        # So this should go to haiku fallback
        assert intent.lecture_number == 4


# ---------------------------------------------------------------------------
# Tests: Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    """Edge cases and boundary conditions."""

    def test_empty_query(self, analyzer: QueryAnalyzer) -> None:
        """Empty query returns default intent with no lecture number."""
        intent = analyzer.analyze("")
        assert intent == QueryIntent()
        assert intent.lecture_number is None

    def test_query_with_only_whitespace(self, analyzer: QueryAnalyzer) -> None:
        """Whitespace-only query returns default intent."""
        intent = analyzer.analyze("   ")
        assert intent == QueryIntent()

    def test_keyword_as_substring_in_word(self, analyzer: QueryAnalyzer) -> None:
        """Keywords match as substrings — 'table' matches in 'timetable'."""
        intent = analyzer.analyze("What is the timetable for next week?")
        assert intent.requires_table is True

    def test_multiple_lecture_numbers_extracts_first(self, analyzer: QueryAnalyzer) -> None:
        """When multiple lecture references exist, extract the first match."""
        intent = analyzer.analyze("Compare lecture 3 and lecture 7")
        assert intent.lecture_number == 3

    def test_all_flags_can_fire(self, analyzer: QueryAnalyzer) -> None:
        """All rule sets can fire simultaneously."""
        query = "Show me the diagram with formula and data covered in lecture 2"
        intent = analyzer.analyze(query)
        assert intent.requires_image is True  # "diagram"
        assert intent.requires_formula is True  # "formula"
        assert intent.requires_table is True  # "data"
        assert intent.needs_summary is True  # "covered" and "lecture"
        assert intent.requires_escalation is True  # "show me"
        assert intent.lecture_number == 2
