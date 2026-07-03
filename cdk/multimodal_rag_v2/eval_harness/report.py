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


# ─── v2 additions: confidence intervals, per-category matrix, arm-E stats ─────

def mean_std_ci(values: list[float]) -> tuple[float, float, float, float]:
    """(mean, std, ci_low, ci_high) with an approximate 95% normal CI.

    n==0 -> all zeros; n==1 -> zero-width CI at the mean. Small-n CIs are a
    rough guide (normal approximation), enough to tell 0.94 from 0.90.
    """
    n = len(values)
    if n == 0:
        return (0.0, 0.0, 0.0, 0.0)
    m = statistics.mean(values)
    if n == 1:
        return (round(m, 4), 0.0, round(m, 4), round(m, 4))
    sd = statistics.stdev(values)
    half = 1.96 * (sd / (n ** 0.5))
    return (round(m, 4), round(sd, 4), round(m - half, 4), round(m + half, 4))


def _by_category(run: ArmRun) -> dict:
    buckets: dict = {}
    for si in run.scored:
        buckets.setdefault(si.category or "(uncat)", []).append(si)
    return buckets


def format_category_matrix(runs: list[ArmRun], metric, metric_name: str) -> str:
    """Category x arm table of a per-item metric's mean (the v2 primary output).

    `metric` is a callable ScoredItem -> float. Cells with no items show '-'.
    """
    if not runs:
        return "(no arms)"
    categories = sorted({(si.category or "(uncat)") for r in runs for si in r.scored})
    arms = [r.arm_name for r in runs]
    per_arm = {r.arm_name: _by_category(r) for r in runs}
    label_w = max([len(metric_name), *(len(c) for c in categories), 6])
    col_w = max(14, *(len(a) for a in arms))

    header = metric_name.ljust(label_w) + "  " + "".join(a.rjust(col_w) for a in arms)
    lines = [header, "-" * len(header)]
    for cat in categories:
        cells = []
        for arm in arms:
            vals = [metric(si) for si in per_arm[arm].get(cat, [])]
            cells.append((f"{mean_std_ci(vals)[0]:.2f}" if vals else "-").rjust(col_w))
        lines.append(cat.ljust(label_w) + "  " + "".join(cells))
    return "\n".join(lines)


def escalation_stats(run: ArmRun) -> dict:
    """Arm-E signals: how often it escalated, and (of those) how often escalation
    actually changed the answer (the agreement-rate evidence)."""
    escalated = [si for si in run.scored if si.escalated]
    n = len(run.scored)
    return {
        "arm": run.arm_name,
        "n": n,
        "escalation_freq": round(len(escalated) / n, 4) if n else 0.0,
        "n_escalated": len(escalated),
        "answer_change_rate_given_escalation": (
            round(sum(1 for si in escalated if si.answer_changed) / len(escalated), 4) if escalated else 0.0
        ),
    }


def export_calibration_sample(
    runs: list[ArmRun], path: str, *, fraction: float = 0.15, seed: int = 0
) -> int:
    """Write a random `fraction` of scored items to `path` as JSON for HUMAN
    review, so the LLM-judge can be calibrated (findings.md "Judge calibration").

    Each row carries what a reviewer needs — question, arm answer, reference
    facts, and the judge's verdict — plus blank `human_*` fields to fill in.
    Deterministic given `seed`. Returns the number of rows written.
    """
    import json
    import random

    rows = [
        {
            "arm": run.arm_name,
            "category": si.category,
            "question": si.query,
            "reference_facts": si.reference_facts,
            "answer": si.answer,
            "judge_correctness": si.correctness,
            "judge_hallucination": si.hallucination,
            "judge_failure_category": si.failure_category,
            "judge_rationale": si.rationale,
            # to be filled in by the human reviewer:
            "human_correctness": None,
            "human_hallucination": None,
            "human_agrees_with_judge": None,
            "human_notes": "",
        }
        for run in runs
        for si in run.scored
    ]
    random.Random(seed).shuffle(rows)
    k = max(1, round(len(rows) * fraction)) if rows else 0
    sample = rows[:k]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sample, f, indent=2, ensure_ascii=False)
    return len(sample)
