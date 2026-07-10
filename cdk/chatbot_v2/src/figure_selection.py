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


def _log_selected(
    selected: list[str], has_figure_ref: bool, specific_ref: bool, escalation_used: bool
) -> None:
    """Emit the final figure-selection decision for observability."""
    if not selected:
        return
    logger.info(
        "Figures selected for display",
        extra={
            "count": len(selected),
            "has_figure_ref": has_figure_ref,
            "specific_figure_ref": specific_ref,
            "escalation_used": escalation_used,
            "retrieval_ids": selected,
        },
    )


def select_figures(
    retrieval_result,
    query: str,
    max_figures: int = _MAX_FIGURES,
    score_threshold: float = _INTENT_SCORE_FLOOR,
) -> list[str]:
    """Select figure retrieval_ids to attach to the response.

    Uses retrieval_id as content identity — never S3 keys or URIs.
    The figure_url endpoint resolves retrieval_id → presigned URL.

    Selection is reference-and-rank-based (M1). Because no cross-encoder is
    configured, the ranker score is RRF-scale (~0.03) and cannot be used as an
    absolute gate. So:
      - specific reference ("figure 4.1")  -> the escalated (analysed) image, or
        a single best image at/above score_threshold when nothing escalated;
      - generic reference ("the diagram") or escalation -> top images by rank;
      - no reference and no escalation      -> nothing (never guess a figure).

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        query: Student's question.
        max_figures: Maximum figures to attach.
        score_threshold: Floor for the specific-reference fallback image only.

    Returns:
        Ordered list of retrieval_ids for figure blocks.
    """
    if retrieval_result is None:
        return []

    _log_candidate_scores("figure", retrieval_result.image_results)

    image_results = retrieval_result.image_results or []
    # S3 keys of the image(s) the vision model actually escalated/analysed. The
    # same key appears on the matching image_results entry, letting us map an
    # escalated analysis back to a displayable retrieval_id.
    escalated_keys = {
        ia.get("image_s3_key")
        for ia in (getattr(retrieval_result, "image_analyses", None) or [])
        if ia.get("image_s3_key")
    }

    fig_match = _FIGURE_REF_PATTERN.search(query)
    has_figure_ref = fig_match is not None
    # All distinct figure NUMBERS named in the query (group(2) is the number).
    # >= 2 distinct numbers => a multi-figure query ("figure 2.1 and figure 4.1").
    specific_numbers = {m.group(2) for m in _FIGURE_REF_PATTERN.finditer(query) if m.group(2)}
    specific_ref = bool(specific_numbers)
    multi_ref = len(specific_numbers) >= 2

    selected: list[str] = []
    seen: set[str] = set()

    def _take(rid: str | None) -> None:
        if rid and rid not in seen:
            selected.append(rid)
            seen.add(rid)

    # A query that names specific figure(s) should show exactly those. Retrieval
    # also returns sibling diagrams from the same file that score highly for being
    # visually similar — not what the student asked for. Prefer the exact images
    # the vision model escalated/analysed (matched by S3 key): one for a single
    # reference, ALL of them for a multi-figure comparison ("2.1 and 4.1").
    if specific_ref:
        if retrieval_result.escalation_used and escalated_keys:
            for img in image_results:
                if len(selected) >= max_figures:
                    break
                if img.get("image_s3_key") in escalated_keys:
                    _take(img.get("retrieval_id"))
        if not selected:
            if multi_ref:
                # Multi-figure query but escalation didn't map keys: fall back to
                # the top images by rank (image_results is score-ordered) so a
                # comparison still surfaces more than one figure — not a single best.
                for img in image_results:
                    if len(selected) >= max_figures:
                        break
                    _take(img.get("retrieval_id"))
            else:
                best_rid, best_score = None, None
                for img in image_results:
                    score = img.get("score", 0) or 0
                    rid = img.get("retrieval_id")
                    if rid and score >= score_threshold and (best_score is None or score > best_score):
                        best_rid, best_score = rid, score
                _take(best_rid)
        _log_selected(selected, has_figure_ref, specific_ref, retrieval_result.escalation_used)
        return selected[:max_figures]

    # Generic figure/diagram query (no specific number) — may surface several.
    # Priority 1: escalated figures attach regardless of score.
    if retrieval_result.escalation_used:
        for img in image_results:
            if len(selected) >= max_figures:
                break
            _take(img.get("retrieval_id"))

    # Priority 2: when the query references figures at all (or escalation ran),
    # show the top images. Reference-and-rank-based (M1): no cross-encoder is
    # configured, so the ranker score is RRF-scale (~0.03) and absolute
    # thresholds never fire — rely on the figure reference + retrieval rank
    # (image_results is already score-ordered) instead of an absolute gate.
    if has_figure_ref or retrieval_result.escalation_used:
        for img in image_results:
            if len(selected) >= max_figures:
                break
            _take(img.get("retrieval_id"))

    # No figure reference and no escalation → do NOT auto-attach an image.
    # The RRF score is not a reliable absolute gate, so surfacing an unreferenced
    # figure risks showing something irrelevant. Show figures only when asked.

    _log_selected(selected, has_figure_ref, specific_ref, retrieval_result.escalation_used)
    return selected


def select_tables(
    retrieval_result,
    query: str,
    max_tables: int = _MAX_TABLES,
) -> list[dict]:
    """Select table blocks from retrieval results.

    Returns table content as markdown (for now). When ingestion stores
    structured headers/rows, this will return structured data instead.

    Reference-and-rank-based (M1): attach the top tables (already rank-ordered
    by retrieval) only when the query references a table; the RRF-scale score is
    not a reliable absolute gate, so it is not used to filter.

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        query: Student's question.
        max_tables: Maximum table blocks to attach.

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

    # Reference-and-rank-based (M1): no cross-encoder is configured, so the
    # ranker score is RRF-scale (~0.03) and absolute thresholds never fire.
    # Show the top tables (already rank-ordered by retrieval) only when the
    # query references a table; never auto-attach on an unreliable score.
    if not has_table_ref:
        return []

    selected: list[dict] = []
    seen: set[str] = set()
    for t in tables:
        if len(selected) >= max_tables:
            break
        rid = t.get("retrieval_id")
        if rid in seen:
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

    # Reference-and-rank-based (M1): RRF-scale scores make absolute thresholds
    # meaningless without a cross-encoder. Show the top formulas (rank-ordered)
    # only when the query references a formula/equation.
    if not has_formula_ref:
        return []

    selected: list[dict] = []
    seen: set[str] = set()
    for f in formulas:
        if len(selected) >= max_formulas:
            break
        rid = f.get("retrieval_id")
        if rid in seen:
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


def build_figure_grounding(retrieval_result, selected_ids: list[str]) -> str:
    """Format the selected figures' descriptions for the response LLM's context.

    The response LLM only sees the retrieval `answer` text; without this it can
    disclaim ("I couldn't find that in the retrieved materials") a figure the
    display path is simultaneously showing. Injecting each selected figure's page
    and caption/description gives the model textual grounding for what it will
    display.

    Args:
        retrieval_result: RetrievalResult from invoke_retrieval().
        selected_ids: retrieval_ids chosen by select_figures() for display.

    Returns:
        A markdown section, or "" when no selected figure has a description.
    """
    if retrieval_result is None or not selected_ids:
        return ""

    image_results = getattr(retrieval_result, "image_results", None) or []
    by_id = {img.get("retrieval_id"): img for img in image_results}

    lines: list[str] = []
    for rid in selected_ids:
        img = by_id.get(rid)
        if not img:
            continue
        description = (img.get("description") or "").strip()
        if not description:
            continue
        page = img.get("page_num")
        label = f"Figure (page {page})" if page is not None else "Figure"
        lines.append(f"- {label}: {description}")

    if not lines:
        return ""

    return (
        "## Figures shown to the student\n"
        "These figures from the course materials are displayed alongside your reply. "
        "Reference and explain them directly; do NOT say a figure cannot be found.\n"
        + "\n".join(lines)
    )


def build_table_grounding(table_blocks: list[dict] | None) -> str:
    """Ground displayed TABLE blocks in the response text (H6).

    Same fix as figures: without this the response LLM only sees the retrieval
    answer and can disclaim a table it is simultaneously displaying. Returns a
    markdown section, or "" when there are no describable tables.
    """
    if not table_blocks:
        return ""
    lines: list[str] = []
    for t in table_blocks:
        summary = (t.get("summary") or t.get("content") or "").strip()
        if not summary:
            headers = t.get("headers") or []
            summary = ("columns: " + ", ".join(headers)) if headers else ""
        if not summary:
            continue
        page = t.get("page")
        label = f"Table (page {page})" if page is not None else "Table"
        lines.append(f"- {label}: {summary}")
    if not lines:
        return ""
    return (
        "## Tables shown to the student\n"
        "These tables from the course materials are displayed alongside your reply. "
        "Reference and explain them directly; do NOT say a table cannot be found.\n"
        + "\n".join(lines)
    )


def build_formula_grounding(formula_blocks: list[dict] | None) -> str:
    """Ground displayed FORMULA blocks in the response text (H6)."""
    if not formula_blocks:
        return ""
    lines: list[str] = []
    for f in formula_blocks:
        latex = (f.get("latex") or f.get("description") or "").strip()
        if not latex:
            continue
        page = f.get("page")
        label = f"Formula (page {page})" if page is not None else "Formula"
        lines.append(f"- {label}: {latex}")
    if not lines:
        return ""
    return (
        "## Formulas shown to the student\n"
        "These formulas from the course materials are displayed alongside your reply. "
        "Reference and explain them directly; do NOT say a formula cannot be found.\n"
        + "\n".join(lines)
    )
