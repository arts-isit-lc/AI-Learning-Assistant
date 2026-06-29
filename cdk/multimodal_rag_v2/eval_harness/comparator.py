"""Deterministic baseline-vs-candidate comparison for the eval harness.

Pure functions only (no Bedrock, no I/O) so the regression gate is
unit-testable and reproducible.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Default regression thresholds. A candidate output must keep at least this
# fraction of the baseline's sources, and its answer length must stay within
# [min, max] x the baseline length. Tunable per run.
DEFAULT_MIN_SOURCE_OVERLAP = 0.5
DEFAULT_MIN_LENGTH_RATIO = 0.5
DEFAULT_MAX_LENGTH_RATIO = 2.5


@dataclass
class OutputSample:
    """One captured pipeline output for a single golden query."""

    query: str
    answer: str
    source_ids: list[str] = field(default_factory=list)
    latency_ms: float = 0.0


@dataclass
class ComparisonResult:
    """Outcome of comparing a candidate output against a baseline."""

    query: str
    passed: bool
    source_overlap: float
    length_ratio: float
    latency_delta_ms: float
    reasons: list[str] = field(default_factory=list)


def jaccard(a: list[str], b: list[str]) -> float:
    """Jaccard similarity of two id lists. Empty/empty == 1.0 (no regression)."""
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    union = sa | sb
    if not union:
        return 1.0
    return len(sa & sb) / len(union)


def compare_outputs(
    baseline: OutputSample,
    candidate: OutputSample,
    *,
    min_source_overlap: float = DEFAULT_MIN_SOURCE_OVERLAP,
    min_length_ratio: float = DEFAULT_MIN_LENGTH_RATIO,
    max_length_ratio: float = DEFAULT_MAX_LENGTH_RATIO,
) -> ComparisonResult:
    """Compare a candidate output against the baseline and decide pass/fail.

    Fails (regression) if any of:
      - candidate answer is empty while baseline was not
      - source overlap (Jaccard) drops below ``min_source_overlap``
      - answer length ratio falls outside [min, max]

    Latency delta is reported (negative = faster) but never fails the gate —
    a latency win that changes content still has to pass the content checks.
    """
    reasons: list[str] = []

    baseline_len = len(baseline.answer or "")
    candidate_len = len(candidate.answer or "")

    if baseline_len > 0 and candidate_len == 0:
        reasons.append("candidate answer is empty but baseline was not")

    overlap = jaccard(baseline.source_ids, candidate.source_ids)
    if overlap < min_source_overlap:
        reasons.append(
            f"source overlap {overlap:.2f} < {min_source_overlap:.2f}"
        )

    # Length ratio relative to baseline; if baseline empty, skip the band check.
    length_ratio = (candidate_len / baseline_len) if baseline_len else 1.0
    if baseline_len and not (min_length_ratio <= length_ratio <= max_length_ratio):
        reasons.append(
            f"length ratio {length_ratio:.2f} outside "
            f"[{min_length_ratio}, {max_length_ratio}]"
        )

    return ComparisonResult(
        query=baseline.query,
        passed=not reasons,
        source_overlap=overlap,
        length_ratio=length_ratio,
        latency_delta_ms=round(candidate.latency_ms - baseline.latency_ms, 2),
        reasons=reasons,
    )
