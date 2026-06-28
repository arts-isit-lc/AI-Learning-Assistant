"""Deterministic block selection for chatbot V2 responses.

Selects figures, tables, and formulas to display based on retrieval results
and escalation data returned by the ragRetrievalFunction.

No embedding calls. No LLM involvement. Pure rule-based selection running
in parallel with LLM generation on shared retrieval outputs.

Block types:
- text: LLM prose answer
- figure: image from course materials (frontend resolves via figure_url endpoint)
- table: table content from retrieval (markdown format for now, structured later)
- formula: LaTeX formula from retrieval
"""

from __future__ import annotations

import os
import re

from aws_lambda_powertools import Logger

logger = Logger(service="chatbot-v2")

# --- Block-attachment thresholds (env-tunable without redeploy) -------------
# Harmonized across figures, tables, and formulas:
#   - with explicit query intent  -> attach candidates scoring >= the intent floor
#   - without intent              -> attach only very-high-confidence candidates
# The defaults are starting points; tune them against the candidate-score logs
# (see _log_candidate_scores) emitted in production.
_INTENT_SCORE_FLOOR = float(os.environ.get("BLOCK_INTENT_SCORE_FLOOR", "0.5"))
_HIGH_CONFIDENCE_THRESHOLD = float(os.environ.get("BLOCK_HIGH_CONFIDENCE_THRESHOLD", "0.8"))
_MAX_FIGURES = int(os.environ.get("BLOCK_MAX_FIGURES", "3"))
_MAX_TABLES = int(os.environ.get("BLOCK_MAX_TABLES", "2"))
_MAX_FORMULAS = int(os.environ.get("BLOCK_MAX_FORMULAS", "2"))

# Regex to detect figure/table/algorithm references in query
_FIGURE_REF_PATTERN = re.compile(
    r"\b(figure|fig\.?|table|algorithm|diagram|image|chart|graph)\s*(\d+(?:[.-]\d+)*)?",
    re.IGNORECASE,
)

# Regex to detect table-related questions
_TABLE_REF_PATTERN = re.compile(
    r"\b(table|comparison|compare|row|column|data)\b",
    re.IGNORECASE,
)

# Regex to detect formula-related questions
_FORMULA_REF_PATTERN = re.compile(
    r"\b(formula|equation|derivation|proof|theorem)\b",
    re.IGNORECASE,
)


def _log_candidate_scores(block_type: str, candidates: list | None) -> None:
    """Log the score distribution of candidate blocks (for threshold tuning).

    Emitted regardless of whether anything is selected, so the absolute
    thresholds can be validated/tuned against real production scores.
    """
    if not candidates:
        return
    scores = sorted((round(c.get("score", 0) or 0, 4) for c in candidates), reverse=True)
    logger.info(
        "Block candidate scores",
        extra={
            "block_type": block_type,
            "candidate_count": len(scores),
            "scores": scores,
            "intent_floor": _INTENT_SCORE_FLOOR,
            "high_confidence_threshold": _HIGH_CONFIDENCE_THRESHOLD,
        },
    )


def select_figures(
    retrieval_result,
    query: str,
    max_figures: int = _MAX_FIGURES,
    score_threshold: float = _INTENT_SCORE_FLOOR,
    high_confidence_threshold: float = _HIGH_CONFIDENCE_THRESHOLD,
) -> list[str]:
    """Select figure retrieval_ids to attach to the response.

    Uses retrieval_id as content identity — never S3 keys or URIs.
    The figure_url endpoint resolves retrieval_id → presigned URL.

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        query: Student's question.
        max_figures: Maximum figures to attach.
        score_threshold: Minimum score for intent-gated selection.
        high_confidence_threshold: Score above which figures attach regardless.

    Returns:
        Ordered list of retrieval_ids for figure blocks.
    """
    if retrieval_result is None:
        return []

    _log_candidate_scores("figure", retrieval_result.image_results)

    selected = []
    seen: set[str] = set()

    has_figure_ref = _FIGURE_REF_PATTERN.search(query) is not None

    # Priority 1: Escalated figure — use retrieval_id from image_results that matches
    if retrieval_result.escalation_used and retrieval_result.image_results:
        for img in retrieval_result.image_results:
            rid = img.get("retrieval_id")
            if rid and rid not in seen:
                selected.append(rid)
                seen.add(rid)
                if len(selected) >= max_figures:
                    break

    # Priority 2: Image results from retrieval (if query references figures)
    if has_figure_ref or retrieval_result.escalation_used:
        for img in retrieval_result.image_results:
            if len(selected) >= max_figures:
                break
            rid = img.get("retrieval_id")
            score = img.get("score", 0) or 0
            if rid and rid not in seen and score >= score_threshold:
                selected.append(rid)
                seen.add(rid)

    # Priority 3: High-confidence fallback (even without figure reference)
    if not selected:
        for img in retrieval_result.image_results:
            if len(selected) >= max_figures:
                break
            rid = img.get("retrieval_id")
            score = img.get("score", 0) or 0
            if rid and rid not in seen and score >= high_confidence_threshold:
                selected.append(rid)
                seen.add(rid)

    if selected:
        logger.info(
            "Figures selected for display",
            extra={
                "count": len(selected),
                "has_figure_ref": has_figure_ref,
                "escalation_used": retrieval_result.escalation_used,
                "retrieval_ids": selected,
            },
        )

    return selected


def select_tables(
    retrieval_result,
    query: str,
    max_tables: int = _MAX_TABLES,
    score_threshold: float = _INTENT_SCORE_FLOOR,
) -> list[dict]:
    """Select table blocks from retrieval results.

    Returns table content as markdown (for now). When ingestion stores
    structured headers/rows, this will return structured data instead.

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        query: Student's question.
        max_tables: Maximum table blocks to attach.
        score_threshold: Minimum score for selection.

    Returns:
        List of table block dicts with type and markdown content.
    """
    if retrieval_result is None:
        return []

    tables = getattr(retrieval_result, "table_results", None) or []
    if not tables:
        return []

    _log_candidate_scores("table", tables)

    has_table_ref = _TABLE_REF_PATTERN.search(query) is not None

    selected: list[dict] = []
    seen: set[str] = set()
    for t in tables:
        if len(selected) >= max_tables:
            break
        rid = t.get("retrieval_id")
        if rid in seen:
            continue
        score = t.get("score", 0) or 0
        # Attach when the query is table-related, or the table scored very high
        # on its own (mirrors the figure high-confidence fallback).
        if not (has_table_ref or score >= _HIGH_CONFIDENCE_THRESHOLD):
            continue
        if score < score_threshold:
            continue
        block = {
            "type": "table",
            "id": rid,
            "headers": t.get("headers", []),
            "rows": t.get("rows", []),
            "summary": t.get("summary", ""),
            "page": t.get("page_num"),
        }
        # Fall back to raw table text when structured headers/rows are unavailable.
        if not block["headers"] and not block["rows"]:
            block["content"] = t.get("content", "")
        selected.append(block)
        if rid:
            seen.add(rid)

    if selected:
        logger.info(
            "Tables selected for display",
            extra={"count": len(selected), "has_table_ref": has_table_ref},
        )
    return selected


def select_formulas(
    retrieval_result,
    query: str,
    max_formulas: int = _MAX_FORMULAS,
) -> list[dict]:
    """Select formula blocks from retrieval results.

    Returns formula content as LaTeX. When ingestion stores structured
    formula data, this will return richer metadata.

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        query: Student's question.
        max_formulas: Maximum formula blocks to attach.

    Returns:
        List of formula block dicts with type, latex, and description.
    """
    if retrieval_result is None:
        return []

    formulas = getattr(retrieval_result, "formula_results", None) or []
    if not formulas:
        return []

    _log_candidate_scores("formula", formulas)

    has_formula_ref = _FORMULA_REF_PATTERN.search(query) is not None

    selected: list[dict] = []
    seen: set[str] = set()
    for f in formulas:
        if len(selected) >= max_formulas:
            break
        rid = f.get("retrieval_id")
        if rid in seen:
            continue
        score = f.get("score", 0) or 0
        if not (has_formula_ref or score >= _HIGH_CONFIDENCE_THRESHOLD):
            continue
        if score < _INTENT_SCORE_FLOOR:
            continue
        selected.append({
            "type": "formula",
            "id": rid,
            "latex": f.get("latex") or f.get("content", ""),
            "description": f.get("content", ""),
            "page": f.get("page_num"),
        })
        if rid:
            seen.add(rid)

    if selected:
        logger.info(
            "Formulas selected for display",
            extra={"count": len(selected), "has_formula_ref": has_formula_ref},
        )
    return selected


def assemble_blocks(
    llm_output: str,
    selected_figures: list[str],
    table_blocks: list[dict] | None = None,
    formula_blocks: list[dict] | None = None,
) -> list[dict]:
    """Assemble canonical block response.

    Text block + typed content blocks grouped at end.
    Order: text → tables → formulas → figures

    Args:
        llm_output: LLM prose answer.
        selected_figures: Ordered retrieval_ids for figure blocks.
        table_blocks: Optional table block dicts.
        formula_blocks: Optional formula block dicts.

    Returns:
        List of blocks — the canonical response format.
    """
    blocks = []

    if llm_output and llm_output.strip():
        blocks.append({"type": "text", "content": llm_output.strip()})

    # Tables after text
    if table_blocks:
        blocks.extend(table_blocks)

    # Formulas after tables
    if formula_blocks:
        blocks.extend(formula_blocks)

    # Figures last (they're the heaviest visual element)
    for retrieval_id in selected_figures:
        blocks.append({"type": "figure", "id": retrieval_id})

    return blocks
