"""Tests for the Step 0 arm-evaluation framework: scoring, runner, report.

Deterministic: the LLM-judge is a fake that scores by substring containment, and
arms are plain callables — no Bedrock, no I/O.
"""
from __future__ import annotations

import pytest

from .figure_dataset import FigureEvalItem
from .report import format_report, summarize
from .runner import run_arm
from .scoring import (
    ArmOutput,
    BedrockCall,
    JudgeScore,
    ScoredItem,
    retrieval_precision,
    score_item,
    sum_tokens,
    total_cost_usd,
)

HAIKU = "anthropic.claude-3-haiku-20240307-v1:0"
SONNET = "anthropic.claude-3-sonnet-20240229-v1:0"


def _fake_judge(query: str, answer: str, facts: list[str]) -> JudgeScore:
    """Deterministic stand-in: correctness = fraction of facts present in the
    answer (substring); hallucination = 1.0 if the answer contains 'HALLUCINATE'."""
    supported = sum(1 for f in facts if f.lower() in answer.lower())
    correctness = supported / len(facts) if facts else 0.0
    return JudgeScore(
        correctness=correctness,
        hallucination=1.0 if "HALLUCINATE" in answer else 0.0,
    )


def _item(**overrides) -> FigureEvalItem:
    base = dict(
        query="What does Figure 1 show?",
        figure_ref="figure 1",
        image_s3_key="k/fig1.png",
        expected_figure_id="rid-x",
        ground_truth_facts=["alpha", "beta"],
    )
    base.update(overrides)
    return FigureEvalItem(**base)


class TestDeterministicMetrics:
    def test_retrieval_precision_hit_miss_and_empty(self):
        assert retrieval_precision("rid-x", ["rid-x", "rid-y"]) == 1.0
        assert retrieval_precision("rid-x", ["rid-y"]) == 0.0
        assert retrieval_precision("", ["anything"]) == 1.0  # no expectation

    def test_sum_tokens_sums_and_clamps_negatives(self):
        calls = [BedrockCall(HAIKU, 1500, 400), BedrockCall(SONNET, 1000, 300), BedrockCall(SONNET, -5, -5)]
        assert sum_tokens(calls) == (2500, 700)

    def test_total_cost_sums_across_calls(self):
        calls = [BedrockCall(HAIKU, 1500, 400), BedrockCall(SONNET, 1000, 300)]
        # Haiku 0.000875 + Sonnet 0.0075 = 0.008375
        assert total_cost_usd(calls) == pytest.approx(0.008375)


class TestScoreItem:
    def test_scores_all_dimensions(self):
        item = _item()
        out = ArmOutput(
            query=item.query,
            answer="the figure contains alpha only",  # supports 1 of 2 facts
            source_ids=["rid-x", "rid-y", "rid-x"],  # 2 unique, expected present
            latency_ms=1234.0,
            calls=[BedrockCall(HAIKU, 1500, 400), BedrockCall(SONNET, 1000, 300)],
        )
        scored = score_item(item, out, _fake_judge)
        assert scored.correctness == pytest.approx(0.5)
        assert scored.hallucination == 0.0
        assert scored.retrieval_precision == 1.0
        assert scored.citations_used == 2
        assert scored.input_tokens == 2500
        assert scored.output_tokens == 700
        assert scored.cost_usd == pytest.approx(0.008375)
        assert scored.latency_ms == 1234.0


class TestRunArm:
    def test_runs_and_scores_every_item(self):
        dataset = [_item(query="Q1"), _item(query="Q2", ground_truth_facts=["alpha"])]

        def arm(item: FigureEvalItem) -> ArmOutput:
            return ArmOutput(
                query=item.query, answer="alpha", source_ids=["rid-x"],
                latency_ms=100.0, calls=[BedrockCall(SONNET, 10, 10)],
            )

        run = run_arm("B", arm, dataset, _fake_judge)
        assert run.arm_name == "B"
        assert len(run.scored) == 2
        assert run.errors == []
        # Q2 has a single fact "alpha" present -> correctness 1.0
        assert run.scored[1].correctness == 1.0

    def test_arm_error_is_recorded_and_run_continues(self):
        dataset = [_item(query="ok"), _item(query="boom"), _item(query="ok2")]

        def arm(item: FigureEvalItem) -> ArmOutput:
            if item.query == "boom":
                raise RuntimeError("vision failed")
            return ArmOutput(query=item.query, answer="alpha beta", source_ids=["rid-x"])

        run = run_arm("A", arm, dataset, _fake_judge)
        assert len(run.scored) == 2  # the two ok items
        assert len(run.errors) == 1
        assert "boom" in run.errors[0] and "vision failed" in run.errors[0]


class TestReport:
    def _run(self):
        from .runner import ArmRun

        return ArmRun(
            arm_name="A",
            scored=[
                ScoredItem("q1", correctness=1.0, hallucination=0.0, retrieval_precision=1.0,
                           citations_used=2, latency_ms=1000.0, input_tokens=100, output_tokens=50, cost_usd=0.001),
                ScoredItem("q2", correctness=0.5, hallucination=1.0, retrieval_precision=0.0,
                           citations_used=1, latency_ms=3000.0, input_tokens=200, output_tokens=100, cost_usd=0.002),
            ],
        )

    def test_summarize_means_and_medians(self):
        s = summarize(self._run())
        assert s.n == 2 and s.errors == 0
        assert s.correctness_mean == pytest.approx(0.75)
        assert s.hallucination_mean == pytest.approx(0.5)
        assert s.retrieval_precision_mean == pytest.approx(0.5)
        assert s.citations_mean == pytest.approx(1.5)
        assert s.latency_ms_median == pytest.approx(2000.0)
        assert s.total_tokens_mean == pytest.approx(225.0)  # (150 + 300)/2
        assert s.cost_usd_mean == pytest.approx(0.0015)

    def test_format_report_contains_arms_and_metrics(self):
        a = summarize(self._run())
        c = summarize(self._run())
        c.arm_name = "C"
        text = format_report([a, c])
        assert "A" in text and "C" in text
        for label in ("correctness", "hallucination", "retrieval_prec", "cost_usd_mean", "latency_ms_med"):
            assert label in text

    def test_format_report_empty(self):
        assert format_report([]) == "(no arms to report)"
