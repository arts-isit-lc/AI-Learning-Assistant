"""Run an evaluation arm over the figure-eval dataset and collect scores.

An `Arm` is any callable `(FigureEvalItem) -> ArmOutput`. This framework is
deliberately client-agnostic: the four Step 0 arms —
  A: live escalation (runtime vision + answer),
  B: stored short ingestion description + answer,
  C: richer stored description + answer,
  D: richer description + revised answer prompt —
are wired with the real pipeline clients (VisionService / ImageEscalation /
ReasoningEngine / Bedrock) in Phase 2/3. Here they are just callables, so the
runner is tested with fakes and no production code is touched.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .figure_dataset import FigureEvalItem
from .scoring import ArmOutput, JudgeFn, ScoredItem, score_item

# An arm produces one ArmOutput per dataset item.
Arm = Callable[[FigureEvalItem], ArmOutput]


@dataclass
class ArmRun:
    """All scored items for one arm over the dataset."""

    arm_name: str
    scored: list[ScoredItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def run_arm(
    arm_name: str,
    arm: Arm,
    dataset: list[FigureEvalItem],
    judge: JudgeFn,
) -> ArmRun:
    """Run one arm over the whole dataset and score each output.

    An arm that raises on a given item is recorded in `errors` and skipped
    (a single bad item never aborts the whole comparison run), mirroring the
    pipeline's log-and-continue convention.
    """
    scored: list[ScoredItem] = []
    errors: list[str] = []
    for item in dataset:
        try:
            output = arm(item)
        except Exception as exc:  # noqa: BLE001 — record and continue
            errors.append(f"{item.query!r}: {type(exc).__name__}: {exc}")
            continue
        scored.append(score_item(item, output, judge))
    return ArmRun(arm_name=arm_name, scored=scored, errors=errors)
