"""QueryAnalyzer classifies queries using a two-tier approach.

Two-tier: rule-based first (free, 70-80% hit rate), Haiku LLM fallback for ambiguous queries.
Also extracts lecture_number and week_number via regex patterns independently.
"""

from __future__ import annotations

import json
import re

from aws_lambda_powertools import Logger

from ..models.data_models import QueryIntent

logger = Logger(service="multimodal-rag-retrieval")

# Regex patterns for extracting lecture and week numbers from queries
_LECTURE_NUMBER_PATTERN = re.compile(r"(?:lecture|lec)[\s_-]*(\d+)", re.IGNORECASE)
_WEEK_NUMBER_PATTERN = re.compile(r"\bweek[\s_-]*(\d+)", re.IGNORECASE)

# Haiku model ID for fallback classification
_HAIKU_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

# Precompiled word-boundary patterns for rule matching (avoids substring false positives)
def _compile_rules(rules: dict[str, list[str]]) -> dict[str, list[re.Pattern]]:
    """Compile keyword lists into word-boundary regex patterns.

    Multi-word phrases use substring matching (they're specific enough).
    Single words use \\b word boundaries to avoid "graph" matching "paragraph".
    """
    compiled = {}
    for flag, keywords in rules.items():
        patterns = []
        for kw in keywords:
            if " " in kw:
                # Multi-word phrases: substring match is fine (specific enough)
                patterns.append(re.compile(re.escape(kw), re.IGNORECASE))
            else:
                # Single words: use word boundaries
                patterns.append(re.compile(rf"\b{re.escape(kw)}\b", re.IGNORECASE))
        compiled[flag] = patterns
    return compiled


class QueryAnalyzer:
    """Two-tier query classifier: rule-based first, Haiku LLM fallback.

    Rule sets (word-boundary matching for single words, substring for phrases):
    - requires_image: figure, diagram, graph, chart, image, picture, visual
    - requires_formula: equation, formula, derive, solve, calculate, prove
    - requires_table: table, compare, statistics, values
    - needs_summary: covered, overview, topics, what was taught
    - requires_escalation: show me, look at, in the figure, in the diagram, colour/color, etc.

    When rules fire -> return immediately (zero LLM cost).
    When no rules fire -> fall back to Claude 3 Haiku for classification.
    Also extracts lecture/week number via regex patterns.
    """

    _RAW_RULES: dict[str, list[str]] = {
        "requires_image": [
            "figure", "diagram", "graph", "chart", "image", "picture", "visual",
        ],
        "requires_formula": [
            "equation", "formula", "derive", "calculate", "prove",
        ],
        "requires_table": [
            "table", "statistics",
        ],
        "needs_summary": [
            "covered", "overview", "topics", "what was taught", "what did we learn",
        ],
        "requires_escalation": [
            "show me", "look at", "in the figure", "in the diagram",
            "in the graph", "in the chart", "in the image",
            "colour", "color", "shown above", "shown below",
            "the figure shows", "this diagram",
        ],
    }

    # Regex patterns for figure/table/algorithm references that need exact-match lookup
    # Captures: group(1) = type (figure/fig/table/algorithm), group(2) = number (1.1, 2-3, 4)
    _FIGURE_LOOKUP_PATTERN = re.compile(
        r"\b(figure|fig\.?|table|algorithm)\s*(\d+(?:[.-]\d+)*)",
        re.IGNORECASE,
    )

    RULES = _compile_rules(_RAW_RULES)

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
        Lecture/week number extraction is always attempted regardless of classification path.

        Args:
            query: The user's search query.

        Returns:
            QueryIntent with flags indicating content type requirements.
        """
        # Rule-based classification: check each rule set using compiled patterns
        intent_flags: dict[str, bool] = {}
        matched_rules: set[str] = set()

        for flag_name, patterns in self.RULES.items():
            for pattern in patterns:
                if pattern.search(query):
                    intent_flags[flag_name] = True
                    matched_rules.add(flag_name)
                    break

        if matched_rules:
            logger.info(
                "Rule-based classification",
                extra={"query": query[:100], "matched_rules": sorted(matched_rules)},
            )
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

        # Always attempt lecture and week number extraction (independent of each other)
        intent.lecture_number = self._extract_lecture_number(query)
        intent.week_number = self._extract_week_number(query)

        # Check for figure/table/algorithm reference patterns (exact-match lookup)
        fig_match = self._FIGURE_LOOKUP_PATTERN.search(query)
        if fig_match:
            intent.requires_figure_lookup = True
            intent.requires_image = True  # figures are visual content

            # Extract structured reference
            from ..models.data_models import FigureReference
            raw_type = fig_match.group(1).lower().rstrip(".")
            ref_type = "figure" if raw_type in ("figure", "fig") else raw_type
            ref_number = fig_match.group(2)
            intent.figure_reference = FigureReference(ref_type=ref_type, number=ref_number)

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
        """Extract lecture number from query.

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

    @staticmethod
    def _extract_week_number(query: str) -> int | None:
        """Extract week number from query.

        Matches patterns like "week 5", "Week_3", "week-2".

        Args:
            query: The user's search query.

        Returns:
            Extracted week number as int, or None if no match found.
        """
        match = _WEEK_NUMBER_PATTERN.search(query)
        if match:
            return int(match.group(1))
        return None
