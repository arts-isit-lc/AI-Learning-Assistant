"""Aggregate ArmRuns into a side-by-side comparison for the A/B/C/D decision.

Pure aggregation (means/medians per metric) + a plain-text table. No I/O or
Bedrock, so it's deterministic and unit-testable. The report is the artifact
that drives the Step 0 "delete / replace / hybrid / keep" decision.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass

from .runner import ArmRun


@dataclass
class ArmSummary:
    """Aggregated metrics for one arm across the dataset."""

    arm_name: str
    n: int
    errors: int
    correctness_mean: float
    hallucination_mean: float
    retrieval_precision_mean: float
    citations_mean: float
    latency_ms_median: float
    total_tokens_mean: float
    cost_usd_mean: float


def _mean(values: list[float]) -> float:
    return round(statistics.mean(values), 4) if values else 0.0


def _median(values: list[float]) -> float:
    return round(statistics.median(values), 2) if values else 0.0


def summarize(run: ArmRun) -> ArmSummary:
    """Reduce one arm's per-item scores to aggregate metrics."""
    s = run.scored
    return ArmSummary(
        arm_name=run.arm_name,
        n=len(s),
        errors=len(run.errors),
        correctness_mean=_mean([i.correctness for i in s]),
        hallucination_mean=_mean([i.hallucination for i in s]),
        retrieval_precision_mean=_mean([i.retrieval_precision for i in s]),
        citations_mean=_mean([float(i.citations_used) for i in s]),
        latency_ms_median=_median([i.latency_ms for i in s]),
        total_tokens_mean=_mean([float(i.input_tokens + i.output_tokens) for i in s]),
        cost_usd_mean=round(_mean([i.cost_usd for i in s]), 6),
    )


def format_report(summaries: list[ArmSummary]) -> str:
    """Render arm summaries as an aligned plain-text comparison table.

    Columns are the arms; rows are the metrics. Designed so A (baseline) sits
    first and B/C/D read left-to-right for the delete/replace/hybrid call.
    """
    if not summaries:
        return "(no arms to report)"

    metrics = [
        ("n", lambda a: str(a.n)),
        ("errors", lambda a: str(a.errors)),
        ("correctness", lambda a: f"{a.correctness_mean:.3f}"),
        ("hallucination", lambda a: f"{a.hallucination_mean:.3f}"),
        ("retrieval_prec", lambda a: f"{a.retrieval_precision_mean:.3f}"),
        ("citations", lambda a: f"{a.citations_mean:.2f}"),
        ("latency_ms_med", lambda a: f"{a.latency_ms_median:.0f}"),
        ("tokens_mean", lambda a: f"{a.total_tokens_mean:.0f}"),
        ("cost_usd_mean", lambda a: f"{a.cost_usd_mean:.6f}"),
    ]

    label_w = max(len(name) for name, _ in metrics)
    col_w = max(12, *(len(a.arm_name) for a in summaries))

    header = "metric".ljust(label_w) + "  " + "".join(a.arm_name.rjust(col_w) for a in summaries)
    lines = [header, "-" * len(header)]
    for name, getter in metrics:
        row = name.ljust(label_w) + "  " + "".join(getter(a).rjust(col_w) for a in summaries)
        lines.append(row)
    return "\n".join(lines)
