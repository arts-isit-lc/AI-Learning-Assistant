"""Deterministic figure selection for chatbot V2 responses.

Selects figures to display based on retrieval results and escalation data
returned by the ragRetrievalFunction. No embedding calls, no LLM involvement.
"""

from __future__ import annotations

import re

from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

# Regex to detect figure/table/algorithm references in query
_FIGURE_REF_PATTERN = re.compile(
    r"\b(figure|fig\.?|table|algorithm)\s*(\d+(?:[.-]\d+)*)",
    re.IGNORECASE,
)


def select_figures(
    retrieval_result,
    query: str,
    max_figures: int = 3,
    score_threshold: float = 0.4,
    high_confidence_threshold: float = 0.8,
) -> list[str]:
    """Select figure IDs to attach to the response.

    Selection rules (priority order):
    1. Escalated figure (always first — user explicitly asked about it)
    2. High-scoring image results from retrieval (if query references images)
    3. High-confidence fallback (score > 0.8, bypasses intent check)

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        query: Student's question.
        max_figures: Maximum figures to attach.
        score_threshold: Minimum score for intent-gated selection.
        high_confidence_threshold: Score above which figures attach regardless.

    Returns:
        Ordered list of figure identifiers (retrieval_ids).
    """
    if retrieval_result is None:
        return []

    selected = []
    seen: set[str] = set()

    has_figure_ref = _FIGURE_REF_PATTERN.search(query) is not None

    # Priority 1: Escalated figure
    if retrieval_result.escalation_used and retrieval_result.image_analyses:
        for analysis in retrieval_result.image_analyses:
            s3_key = analysis.get("image_s3_key")
            if s3_key and s3_key not in seen:
                # Use s3_key as the identifier (figure_url endpoint resolves it)
                selected.append(s3_key)
                seen.add(s3_key)
                if len(selected) >= max_figures:
                    break

    # Priority 2: Image results from retrieval
    if has_figure_ref or retrieval_result.escalation_used:
        for img in retrieval_result.image_results:
            if len(selected) >= max_figures:
                break
            s3_key = img.get("image_s3_key")
            score = img.get("score", 0)
            if s3_key and s3_key not in seen and score > score_threshold:
                selected.append(s3_key)
                seen.add(s3_key)

    # Priority 3: High-confidence fallback (even without figure reference)
    if not selected:
        for img in retrieval_result.image_results:
            if len(selected) >= max_figures:
                break
            s3_key = img.get("image_s3_key")
            score = img.get("score", 0)
            if s3_key and s3_key not in seen and score > high_confidence_threshold:
                selected.append(s3_key)
                seen.add(s3_key)

    if selected:
        logger.info(
            "Figures selected for display",
            extra={
                "count": len(selected),
                "has_figure_ref": has_figure_ref,
                "escalation_used": retrieval_result.escalation_used,
            },
        )

    return selected


def assemble_blocks(llm_output: str, selected_figures: list[str]) -> list[dict]:
    """Assemble canonical block response.

    Text block + figure blocks grouped at end.

    Args:
        llm_output: LLM prose answer.
        selected_figures: Ordered figure identifiers (image_s3_keys).

    Returns:
        List of blocks — the canonical response format.
    """
    blocks = []

    if llm_output and llm_output.strip():
        blocks.append({"type": "text", "content": llm_output.strip()})

    for figure_id in selected_figures:
        blocks.append({"type": "figure", "id": figure_id})

    return blocks
