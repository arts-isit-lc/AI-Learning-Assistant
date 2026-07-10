"""Quality + cost/performance scoring for the Step 0 arm comparison.

Deterministic metrics (retrieval precision, citations, tokens, cost, latency)
are pure functions. Answer-quality metrics (correctness, hallucination) come
from an INJECTED judge callable, so this module is fully testable without
Bedrock; the production judge wraps an LLM-as-judge Bedrock call and is supplied
at run time (Phase 3).

Cost/tokens are summed across every Bedrock call an arm makes, so arm A
(vision + answer) is compared to arm B/C/D (answer only) on equal footing.
See .kiro/specs/chatbot-latency-optimization/findings.md (Step 0 metrics).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from ..pricing import estimate_cost_usd
from .figure_dataset import FigureEvalItem


@dataclass
class BedrockCall:
    """One model invocation an arm made (for token/cost accounting)."""

    model_id: str
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class ArmOutput:
    """One arm's output for one dataset item.

    `calls` lists every Bedrock invocation the arm made to produce this answer
    (e.g. arm A = [vision, answer]; arm B/C/D = [answer]); token/cost metrics sum
    over it. `latency_ms` is the arm's own measured wall time.
    """

    query: str
    answer: str
    source_ids: list[str] = field(default_factory=list)
    latency_ms: float = 0.0
    calls: list[BedrockCall] = field(default_factory=list)
    # v2 (arm E hybrid): whether this turn escalated to live perception, and
    # whether escalation actually changed the answer (agreement-rate signal).
    escalated: bool = False
    answer_changed: bool = False


@dataclass
class JudgeScore:
    """LLM-judge verdict for one answer against its ground-truth facts."""

    correctness: float  # 0..1 — fraction of ground-truth facts supported
    hallucination: float  # 0..1 — degree of unsupported/contradicted claims
    rationale: str = ""
    failure_category: str = ""  # v2 taxonomy (see experiment_v2.FAILURE_CATEGORIES); "" when correct


# A judge maps (query, answer, ground_truth_facts) -> JudgeScore.
JudgeFn = Callable[[str, str, list[str]], JudgeScore]


@dataclass
class ScoredItem:
    """All metrics for one arm's output on one dataset item."""

    query: str
    correctness: float
    hallucination: float
    retrieval_precision: float
    citations_used: int
    latency_ms: float
    input_tokens: int
    output_tokens: int
    cost_usd: float
    # v2 breakdown fields
    category: str = ""
    failure_category: str = ""
    escalated: bool = False
    answer_changed: bool = False
    # inspection fields for judge calibration (what the human reviewer sees)
    answer: str = ""
    rationale: str = ""
    reference_facts: list[str] = field(default_factory=list)


_NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def _numbers_in(text: str) -> set[str]:
    """Numeric tokens (integers/decimals) in a string, ignoring thousands-commas."""
    return set(_NUMBER_RE.findall((text or "").replace(",", "")))


def unsupported_numeric_values(answer: str, supplied_texts: list[str]) -> list[str]:
    """Numeric tokens in ``answer`` that appear in NONE of the supplied artifacts.

    The behavioral faithfulness check for cross-modal explanation (AC-3B / spec §11):
    when the supplied image has no visible numeric labels, every number in the
    answer must come from the supplied reference/image content. Any value returned
    here is an invented number — the exact failure mode observed in the bad response
    (fabricated latencies). Deterministic + pure: the eval harness runs the REAL
    model to produce ``answer``, then asserts this list is empty. Thousands-commas
    are normalized so "11,800" and "11800" match.
    """
    supplied: set[str] = set()
    for text in supplied_texts:
        supplied |= _numbers_in(text)
    return sorted(n for n in _numbers_in(answer) if n not in supplied)


def retrieval_precision(expected_figure_id: str, source_ids: list[str]) -> float:
    """1.0 if the expected figure surfaced in the answer's sources, else 0.0.

    An empty expectation returns 1.0 (the item makes no retrieval claim, so it
    is not penalized).
    """
    if not expected_figure_id:
        return 1.0
    return 1.0 if expected_figure_id in set(source_ids) else 0.0


def sum_tokens(calls: list[BedrockCall]) -> tuple[int, int]:
    """Return (total_input_tokens, total_output_tokens) across all calls."""
    return (
        sum(max(0, c.input_tokens) for c in calls),
        sum(max(0, c.output_tokens) for c in calls),
    )


def total_cost_usd(calls: list[BedrockCall]) -> float:
    """Sum the estimated USD cost across every call the arm made."""
    return round(
        sum(estimate_cost_usd(c.model_id, c.input_tokens, c.output_tokens) for c in calls),
        6,
    )


def score_item(item: FigureEvalItem, output: ArmOutput, judge: JudgeFn) -> ScoredItem:
    """Score one arm output against a dataset item.

    Quality (correctness/hallucination) is delegated to the injected judge;
    everything else is computed deterministically from the output.
    """
    verdict = judge(output.query, output.answer, item.ground_truth_facts)
    in_tok, out_tok = sum_tokens(output.calls)
    return ScoredItem(
        query=item.query,
        correctness=verdict.correctness,
        hallucination=verdict.hallucination,
        retrieval_precision=retrieval_precision(item.expected_figure_id, output.source_ids),
        citations_used=len(set(output.source_ids)),
        latency_ms=output.latency_ms,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cost_usd=total_cost_usd(output.calls),
        category=item.category,
        failure_category=verdict.failure_category,
        escalated=output.escalated,
        answer_changed=output.answer_changed,
        answer=output.answer,
        rationale=verdict.rationale,
        reference_facts=list(item.ground_truth_facts),
    )
