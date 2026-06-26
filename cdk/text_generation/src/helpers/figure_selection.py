"""Deterministic figure selection for image display in chat responses.

Implements Phase 1 of the Image Display Architecture:
- Eligibility gate: figures must satisfy at least one hard rule
- Grounding check: figures must be connected to query/context via co-location
- Selection: capped, priority-ordered, intent-gated with high-confidence fallback
- Block assembly: text block + figure blocks grouped at end

No LLM involvement. No embedding calls. Pure rule-based selection running
in parallel with LLM generation on shared retrieval outputs.
"""

from __future__ import annotations

from aws_lambda_powertools import Logger
from langchain_core.documents import Document

from helpers.image_escalation import detect_figure_reference

logger = Logger(service="text-generation")


def is_grounded(figure_metadata: dict, text_results: list[Document]) -> bool:
    """Check if a figure is grounded in the supporting context.

    A figure is grounded if it co-locates with a top text chunk:
    same page + same module. This uses existing retrieval metadata —
    no additional embedding calls or DB queries.

    Args:
        figure_metadata: The figure document's metadata dict.
        text_results: Top text documents from retrieval (used for co-location check).

    Returns:
        True if the figure is grounded in context.
    """
    fig_page = figure_metadata.get("page_num")
    fig_module = figure_metadata.get("module_id")

    if not fig_page or not fig_module:
        # Cannot verify co-location without provenance — allow by default
        return True

    for text_doc in text_results[:5]:
        text_page = text_doc.metadata.get("page_num")
        text_module = text_doc.metadata.get("module_id")

        # Co-location: same page in same module
        if text_page and text_module == fig_module and text_page == fig_page:
            return True

    return False


def get_eligible_figures(
    image_results: list[Document],
    text_results: list[Document],
    query: str,
    escalation_figure_id: str | None = None,
    top_k: int = 5,
    intent_threshold: float = 0.4,
    fallback_threshold: float = 0.8,
) -> list[dict]:
    """Determine which figures are eligible for display.

    Eligibility requires at least one hard signal:
    1. Escalation match (user explicitly asked about a figure)
    2. Top-K retrieval rank (figure is highly relevant)
    3. High-confidence fallback (score > 0.8 bypasses intent)

    Grounding check adds precision: demotes ungrounded figures.

    Args:
        image_results: Image-type documents from retrieval (ordered by score).
        text_results: Text-type documents from retrieval (for grounding check).
        query: The student's question (for figure reference detection).
        escalation_figure_id: Figure ID from escalation (if triggered).
        top_k: Maximum retrieval rank for eligibility.
        intent_threshold: Minimum score when query references images.
        fallback_threshold: Score above which figures are always eligible.

    Returns:
        List of eligible figure dicts with figure_id, reason, priority, grounded.
    """
    eligible = []
    seen: set[str] = set()

    # Detect if query references a figure (lightweight intent signal)
    has_figure_ref = detect_figure_reference(query) is not None

    # Rule 1: Escalated figure (always eligible, highest priority, skip grounding)
    if escalation_figure_id:
        eligible.append({
            "figure_id": escalation_figure_id,
            "reason": "escalation",
            "priority": 0,
            "grounded": True,
            "score": 1.0,
        })
        seen.add(escalation_figure_id)

    for rank, doc in enumerate(image_results):
        fig_id = doc.metadata.get("figure_id") or doc.metadata.get("retrieval_id")
        image_s3_key = doc.metadata.get("image_s3_key")

        if not fig_id or fig_id in seen or not image_s3_key:
            continue

        score = doc.metadata.get("rrf_score", 0.0)
        reasons = []

        # Rule 2: Top-K retrieval rank
        if rank < top_k:
            reasons.append("top_k_retrieval")

        # Rule 3: Query references a figure + score threshold
        if has_figure_ref and score > intent_threshold:
            reasons.append("figure_ref_and_score")

        # Rule 4: High-confidence fallback (bypasses all other checks)
        if score > fallback_threshold:
            reasons.append("high_confidence")

        if not reasons:
            continue

        # Grounding check
        grounded = is_grounded(doc.metadata, text_results)

        if not grounded:
            logger.info(
                "Figure eligible but ungrounded — demoted",
                extra={
                    "figure_id": fig_id,
                    "reasons": reasons,
                    "score": score,
                    "page_num": doc.metadata.get("page_num"),
                },
            )

        eligible.append({
            "figure_id": fig_id,
            "reason": reasons[0],
            "priority": rank + 1 if grounded else rank + 100,
            "score": score,
            "grounded": grounded,
            "image_s3_key": image_s3_key,
        })
        seen.add(fig_id)

    return eligible


def select_figures(
    eligible_figures: list[dict],
    query: str,
    max_figures: int = 3,
) -> list[str]:
    """Select final figures from the eligible set.

    Rules:
    - Escalated figure always included (first)
    - Grounded figures prioritized over ungrounded
    - Ordered by priority (retrieval rank)
    - Capped at max_figures
    - If no escalation and no high-confidence grounded figures and no figure
      reference in query → return empty (text-only response)

    Args:
        eligible_figures: Output from get_eligible_figures().
        query: The student's question (for intent detection).
        max_figures: Maximum figures to attach.

    Returns:
        Ordered list of figure_ids for block assembly.
    """
    if not eligible_figures:
        return []

    has_escalation = any(f["reason"] == "escalation" for f in eligible_figures)
    has_high_confidence_grounded = any(
        f["reason"] == "high_confidence" and f.get("grounded", True)
        for f in eligible_figures
    )
    has_figure_ref = detect_figure_reference(query) is not None

    # Intent gate: only show figures if there's a reason to
    if not has_escalation and not has_high_confidence_grounded and not has_figure_ref:
        return []

    # Select in priority order
    selected = []
    for fig in sorted(eligible_figures, key=lambda f: f["priority"]):
        if len(selected) >= max_figures:
            break
        selected.append(fig["figure_id"])

    logger.info(
        "Figures selected for display",
        extra={
            "selected_count": len(selected),
            "eligible_count": len(eligible_figures),
            "figure_ids": selected,
            "has_escalation": has_escalation,
            "has_figure_ref": has_figure_ref,
        },
    )

    return selected


def assemble_blocks(answer: str, selected_figures: list[str]) -> list[dict]:
    """Assemble canonical block response.

    Text block + figure blocks grouped at end.

    Args:
        answer: LLM prose answer.
        selected_figures: Ordered figure_ids from select_figures().

    Returns:
        List of blocks — the canonical response format.
    """
    blocks = []

    if answer and answer.strip():
        blocks.append({"type": "text", "content": answer.strip()})

    for figure_id in selected_figures:
        blocks.append({"type": "figure", "id": figure_id})

    return blocks
