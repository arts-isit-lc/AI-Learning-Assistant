"""QueryAnalyzer classifies queries using a two-tier approach.

Two-tier: rule-based first (free, 70-80% hit rate), Haiku LLM fallback for ambiguous queries.
Also extracts lecture_number via regex patterns.
"""

from __future__ import annotations

import json
import re

from aws_lambda_powertools import Logger

from ..models.data_models import QueryIntent

logger = Logger(service="multimodal-rag-retrieval")

# Regex pattern for extracting lecture numbers from queries
_LECTURE_NUMBER_PATTERN = re.compile(r"(?:lecture|lec)[\s_-]*(\d+)", re.IGNORECASE)

# Haiku model ID for fallback classification
_HAIKU_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"


class QueryAnalyzer:
    """Two-tier query classifier: rule-based first, Haiku LLM fallback.

    Rule sets (case-insensitive substring matching):
    - requires_image: figure, diagram, graph, chart, image, picture, map, visual
    - requires_formula: equation, formula, derive, solve, calculate, prove
    - requires_table: data, table, compare, statistics, values
    - needs_summary: covered, lecture, overview, topics, about
    - requires_escalation: show me, look at, in the figure, this diagram

    When rules fire -> return immediately (zero LLM cost).
    When no rules fire -> fall back to Claude 3 Haiku for classification.
    Also extracts lecture_number via regex patterns.
    """

    RULES: dict[str, list[str]] = {
        "requires_image": [
            "figure", "diagram", "graph", "chart", "image", "picture", "map", "visual",
        ],
        "requires_formula": [
            "equation", "formula", "derive", "solve", "calculate", "prove",
        ],
        "requires_table": [
            "data", "table", "compare", "statistics", "values",
        ],
        "needs_summary": [
            "covered", "lecture", "overview", "topics", "about",
        ],
        "requires_escalation": [
            "show me", "look at", "in the figure", "this diagram",
        ],
    }

    def __init__(self, bedrock_client=None):
        """Initialize QueryAnalyzer.

        Args:
            bedrock_client: Optional boto3 Bedrock Runtime client for Haiku fallback.
                           If None, Haiku fallback returns default QueryIntent (all flags false).
        """
        self._bedrock_client = bedrock_client

    def analyze(self, query: str) -> QueryIntent:
        """Analyze a query to determine intent and required content types.

        Rule-based classification fires first. If any rules match, returns immediately
        at zero LLM cost. If no rules fire, falls back to Haiku for classification.
        Lecture number extraction is always attempted regardless of classification path.

        Args:
            query: The user's search query.

        Returns:
            QueryIntent with flags indicating content type requirements.
        """
        query_lower = query.lower()

        # Rule-based classification: check each rule set
        intent_flags: dict[str, bool] = {}
        any_rule_fired = False

        for flag_name, keywords in self.RULES.items():
            for keyword in keywords:
                if keyword in query_lower:
                    intent_flags[flag_name] = True
                    any_rule_fired = True
                    break

        if any_rule_fired:
            intent = QueryIntent(
                needs_summary=intent_flags.get("needs_summary", False),
                requires_image=intent_flags.get("requires_image", False),
                requires_formula=intent_flags.get("requires_formula", False),
                requires_table=intent_flags.get("requires_table", False),
                requires_escalation=intent_flags.get("requires_escalation", False),
            )
        else:
            # Haiku fallback for ambiguous queries
            intent = self._haiku_fallback(query)

        # Always attempt lecture number extraction
        intent.lecture_number = self._extract_lecture_number(query)

        return intent

    def _haiku_fallback(self, query: str) -> QueryIntent:
        """Fall back to Claude 3 Haiku for query classification.

        Invoked only when no rules fire. On failure, returns default QueryIntent
        with all flags set to false.

        Args:
            query: The user's search query.

        Returns:
            QueryIntent from Haiku classification or default on failure.
        """
        if self._bedrock_client is None:
            logger.warning("No Bedrock client available for Haiku fallback, returning default intent")
            return QueryIntent()

        prompt = (
            "Classify this student query for a learning assistant. "
            "Return ONLY a JSON object with these boolean fields:\n"
            "- needs_summary: true if asking about what a lecture/topic covers\n"
            "- requires_image: true if the answer likely needs diagrams/figures/images\n"
            "- requires_formula: true if the answer involves equations/formulas/derivations\n"
            "- requires_table: true if the answer involves data/tables/comparisons\n"
            "- requires_escalation: true if referring to a specific visual element\n\n"
            f"Query: {query}\n\n"
            "JSON:"
        )

        try:
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 200,
                "messages": [
                    {"role": "user", "content": prompt}
                ],
            })

            response = self._bedrock_client.invoke_model(
                modelId=_HAIKU_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=body,
            )

            response_body = json.loads(response["body"].read())
            content_text = response_body["content"][0]["text"]

            # Parse JSON from response (handle potential markdown wrapping)
            json_str = content_text.strip()
            if json_str.startswith("```"):
                # Strip markdown code fences
                json_str = json_str.split("\n", 1)[-1]
                json_str = json_str.rsplit("```", 1)[0]
            json_str = json_str.strip()

            classification = json.loads(json_str)

            return QueryIntent(
                needs_summary=bool(classification.get("needs_summary", False)),
                requires_image=bool(classification.get("requires_image", False)),
                requires_formula=bool(classification.get("requires_formula", False)),
                requires_table=bool(classification.get("requires_table", False)),
                requires_escalation=bool(classification.get("requires_escalation", False)),
            )

        except Exception:
            logger.exception("Haiku fallback classification failed, returning default intent")
            return QueryIntent()

    @staticmethod
    def _extract_lecture_number(query: str) -> int | None:
        """Extract lecture number from query using regex patterns.

        Matches patterns like "lecture 7", "lec 3", "Lecture_12", "lec-5".

        Args:
            query: The user's search query.

        Returns:
            Extracted lecture number as int, or None if no match found.
        """
        match = _LECTURE_NUMBER_PATTERN.search(query)
        if match:
            return int(match.group(1))
        return None
