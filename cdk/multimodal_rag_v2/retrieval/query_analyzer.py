"""QueryAnalyzer classifies queries using a two-tier approach.

Two-tier: rule-based first (free, 70-80% hit rate), Haiku LLM fallback for ambiguous queries.
Also extracts lecture_number and week_number via regex patterns independently.
"""

from __future__ import annotations

import json
import re

from aws_lambda_powertools import Logger

from ..models.data_models import FigureReference, QueryIntent

logger = Logger(service="multimodal-rag-retrieval")

# Regex patterns for extracting lecture and week numbers from queries
_LECTURE_NUMBER_PATTERN = re.compile(r"(?:lecture|lec)[\s_-]*(\d+)", re.IGNORECASE)
_WEEK_NUMBER_PATTERN = re.compile(r"\bweek[\s_-]*(\d+)", re.IGNORECASE)

# Haiku 4.5 model ID for fallback classification (Geo-US cross-Region inference)
_HAIKU_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

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
    - requires_formula: equation, formula, derive, calculate, prove
    - requires_table: table, statistics
    - needs_summary: covered, overview, topics, what was taught
    - requires_escalation: show me, look at, in the figure, in the diagram, colour/color, etc.

    Keyword sets are deliberately curated/narrow. Broad words (solve, compare,
    data, values, about, map) are intentionally excluded — they produced false
    positives and are better handled by the Haiku fallback. See
    test_query_analyzer_v2.py::TestRemovedBroadKeywords.

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
    # Deliberately narrow: only figure/table/algorithm are numbered-reference types.
    # Do NOT add "equation" here — it would incorrectly set requires_image=True.
    _FIGURE_LOOKUP_PATTERN = re.compile(
        r"\b(figure|fig\.?|table|algorithm)\s*(\d+(?:[.-]\d+)*)",
        re.IGNORECASE,
    )

    # Comparison-intent language. Only sets requires_comparison alongside >= 2
    # figure references (see analyze) — a match with < 2 references is ignored, so
    # "compare this to lecture 3" (zero/one figures) is not a figure comparison.
    _COMPARISON_PATTERN = re.compile(
        r"\b(compare|comparison|versus|vs|difference|differences|better|worse|best|"
        r"which one|which is|stronger|clearer)\b",
        re.IGNORECASE,
    )

    # Max distinct references parsed per query (abuse guard + downstream cost bound).
    _MAX_PARSED_REFERENCES = 5

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

        # Check for figure/table/algorithm reference patterns (exact-match lookup).
        # Capture ALL distinct references (finditer, not search) so a multi-figure
        # query ("compare figure 2.1 and figure 4.1") is not collapsed to the first.
        references = self._extract_figure_references(query)
        if references:
            intent.requires_figure_lookup = True
            intent.requires_image = True  # figures are visual content
            intent.figure_references = references
            intent.figure_reference = references[0]  # back-compat: single-reference consumers
            intent.requires_multi_image = len(references) >= 2
            intent.requires_comparison = (
                intent.requires_multi_image
                and self._COMPARISON_PATTERN.search(query) is not None
            )
            # Table-native comparison is an INDEPENDENT signal: >= 2 distinct
            # TABLE references + comparison language. It reuses the parsed
            # references (tables are already captured by _FIGURE_LOOKUP_PATTERN)
            # but routes to the deterministic table comparator, not the vision
            # path. A mixed query ("table 2.1 and figure 4.1") has < 2 table
            # refs, so it does not trigger this (mixed-type is out of scope).
            table_refs = [r for r in references if r.ref_type == "table"]
            intent.requires_table_comparison = (
                len(table_refs) >= 2
                and self._COMPARISON_PATTERN.search(query) is not None
            )

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

        import time
        haiku_start = time.time()

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

            haiku_latency = time.time() - haiku_start
            logger.info(
                "Haiku fallback classification complete",
                extra={
                    "query_preview": query[:80],
                    "classification": classification,
                    "haiku_latency_ms": round(haiku_latency * 1000, 2),
                    "input_tokens": response_body.get("usage", {}).get("input_tokens", 0),
                    "output_tokens": response_body.get("usage", {}).get("output_tokens", 0),
                },
            )

            return QueryIntent(
                needs_summary=bool(classification.get("needs_summary", False)),
                requires_image=bool(classification.get("requires_image", False)),
                requires_formula=bool(classification.get("requires_formula", False)),
                requires_table=bool(classification.get("requires_table", False)),
                requires_escalation=bool(classification.get("requires_escalation", False)),
            )

        except Exception:
            haiku_latency = time.time() - haiku_start
            logger.exception(
                "Haiku fallback classification failed, returning default intent",
                extra={"haiku_latency_ms": round(haiku_latency * 1000, 2)},
            )
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

    @classmethod
    def _extract_figure_references(cls, query: str) -> list[FigureReference]:
        """Extract every distinct figure/table/algorithm reference, in order.

        Uses finditer (not search) so multi-figure queries keep every reference.
        De-duplicated by (ref_type, number) preserving first-seen order and bounded
        by _MAX_PARSED_REFERENCES so a query stuffed with "figure N" tokens cannot
        fan out into unbounded downstream image lookups.
        """
        seen: set[tuple[str, str]] = set()
        refs: list[FigureReference] = []
        for match in cls._FIGURE_LOOKUP_PATTERN.finditer(query):
            raw_type = match.group(1).lower().rstrip(".")
            ref_type = "figure" if raw_type in ("figure", "fig") else raw_type
            number = match.group(2)
            key = (ref_type, number)
            if key in seen:
                continue
            seen.add(key)
            refs.append(FigureReference(ref_type=ref_type, number=number))
            if len(refs) >= cls._MAX_PARSED_REFERENCES:
                break
        return refs
