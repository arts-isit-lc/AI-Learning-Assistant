"""Tests for the Step 0 v2 additions: failure-taxonomy judge, question gen,
uncertainty parsing, reuse arm builder, hybrid arm E, and report v2 stats.

Deterministic: fake ops/invoke + fake clock — no Bedrock, no S3.
"""
from __future__ import annotations

import pytest

from .experiment_v2 import (
    ANSWER_SYSTEM_UNCERTAINTY,
    CATEGORY_NAMES,
    FAILURE_CATEGORIES,
    build_answer_arm,
    build_hybrid_arm_e,
    build_judge_prompt_v2,
    build_question_gen_prompt,
    make_text_judge_v2,
    parse_judge_response_v2,
    parse_question_gen_response,
    parse_uncertainty,
)
from .experiment import ANSWER_SYSTEM_REVISED
from .figure_dataset import FigureEvalItem
from .report import escalation_stats, format_category_matrix, mean_std_ci
from .runner import ArmRun
from .scoring import BedrockCall, ScoredItem


def _item(**kw) -> FigureEvalItem:
    base = dict(query="Q?", figure_ref="", image_s3_key="k", expected_figure_id="",
                ground_truth_facts=["f"], category="label_lookup")
    base.update(kw)
    return FigureEvalItem(**base)


class TestJudgeV2:
    def test_prompt_lists_taxonomy(self):
        p = build_judge_prompt_v2("q", "a", ["f1"])
        assert "failure_category" in p and "wrong_figure" in p and "f1" in p

    def test_parse_valid_failure_category(self):
        js = parse_judge_response_v2('{"correctness":0.5,"hallucination":0.2,"failure_category":"ocr_error","rationale":"r"}')
        assert js.failure_category == "ocr_error"
        assert js.correctness == pytest.approx(0.5)

    def test_parse_unknown_failure_category_becomes_other(self):
        js = parse_judge_response_v2('{"correctness":1,"hallucination":0,"failure_category":"bogus"}')
        assert js.failure_category == "other"

    def test_parse_missing_failure_category_is_empty(self):
        js = parse_judge_response_v2('{"correctness":1,"hallucination":0}')
        assert js.failure_category == ""

    def test_make_judge_unparseable_scores_zero(self):
        judge = make_text_judge_v2(lambda p: "no json")
        js = judge("q", "a", ["f"])
        assert js.correctness == 0.0 and js.failure_category == "other"

    def test_taxonomy_has_none_sentinel(self):
        assert FAILURE_CATEGORIES[0] == "none"


class TestQuestionGen:
    def test_prompt_lists_categories(self):
        p = build_question_gen_prompt()
        for name in CATEGORY_NAMES:
            assert name in p

    def test_parse_filters_to_known_categories(self):
        raw = '{"overview": "what is this?", "label_lookup": "which axis?", "bogus": "ignored", "chart": ""}'
        out = parse_question_gen_response(raw)
        assert out == {"overview": "what is this?", "label_lookup": "which axis?"}  # bogus + empty dropped

    def test_parse_non_object_raises(self):
        with pytest.raises(ValueError):
            parse_question_gen_response("[1,2,3]")


class TestUncertainty:
    def test_no_marker(self):
        clean, unc, reason = parse_uncertainty("just an answer")
        assert clean == "just an answer" and unc is False and reason == ""

    def test_yes_marker_splits_and_flags(self):
        clean, unc, reason = parse_uncertainty("The answer is X.\nUNCERTAINTY: yes - description lacked the axis")
        assert clean == "The answer is X." and unc is True
        assert "axis" in reason

    def test_no_marker_value(self):
        clean, unc, _ = parse_uncertainty("Answer.\nUNCERTAINTY: no - fully covered")
        assert unc is False and clean == "Answer."


class TestArmBuilders:
    def test_answer_arm_reuses_provided_perception_no_perception_call(self):
        provider = lambda item: ("PRECOMPUTED", [])  # query-agnostic, no call
        seen = {}

        def answer_op(system, user):
            seen["user"] = user
            return ("ANS", BedrockCall("sonnet", 5, 5))

        arm = build_answer_arm(provider, ANSWER_SYSTEM_REVISED, answer_op, clock=iter([0.0, 0.2]).__next__)
        out = arm(_item())
        assert out.answer == "ANS"
        assert [c.model_id for c in out.calls] == ["sonnet"]  # only the answer call
        assert "PRECOMPUTED" in seen["user"]
        assert out.latency_ms == 200.0

    def test_hybrid_e_no_escalation_when_certain(self):
        stored = lambda item: ("STORED", [])
        live = lambda item: ("LIVE", [BedrockCall("haiku", 1, 1)])

        def answer_op(system, user):
            return ("Stored answer.\nUNCERTAINTY: no - fine", BedrockCall("sonnet", 2, 2))

        arm = build_hybrid_arm_e(stored, live, answer_op, clock=iter([0.0, 0.1]).__next__)
        out = arm(_item())
        assert out.escalated is False
        assert out.answer == "Stored answer."
        assert len(out.calls) == 1  # only the first answer call, no live perception

    def test_hybrid_e_escalates_when_uncertain_and_records_change(self):
        stored = lambda item: ("STORED", [])
        live = lambda item: ("LIVE", [BedrockCall("haiku", 1, 1)])

        def answer_op(system, user):
            if system == ANSWER_SYSTEM_UNCERTAINTY:
                return ("Stored guess.\nUNCERTAINTY: yes - insufficient", BedrockCall("sonnet", 2, 2))
            return ("Different live answer.", BedrockCall("sonnet", 3, 3))  # ANSWER_SYSTEM_REVISED

        arm = build_hybrid_arm_e(stored, live, answer_op, clock=iter([0.0, 0.3]).__next__)
        out = arm(_item())
        assert out.escalated is True
        assert out.answer == "Different live answer."
        assert out.answer_changed is True
        # calls: first answer + live perception + re-answer
        assert [c.model_id for c in out.calls] == ["sonnet", "haiku", "sonnet"]

    def test_hybrid_e_escalation_no_change_when_same_answer(self):
        stored = lambda item: ("STORED", [])
        live = lambda item: ("LIVE", [])

        def answer_op(system, user):
            if system == ANSWER_SYSTEM_UNCERTAINTY:
                return ("Same answer.\nUNCERTAINTY: yes - unsure", BedrockCall("sonnet", 1, 1))
            return ("Same answer.", BedrockCall("sonnet", 1, 1))

        arm = build_hybrid_arm_e(stored, live, answer_op, clock=iter([0.0, 0.1]).__next__)
        out = arm(_item())
        assert out.escalated is True
        assert out.answer_changed is False  # normalized equal


class TestReportV2:
    def test_mean_std_ci(self):
        assert mean_std_ci([]) == (0.0, 0.0, 0.0, 0.0)
        assert mean_std_ci([0.9]) == (0.9, 0.0, 0.9, 0.9)
        m, sd, lo, hi = mean_std_ci([0.8, 1.0])
        assert m == pytest.approx(0.9) and lo < m < hi

    def _scored(self, cat, corr, escalated=False, changed=False) -> ScoredItem:
        return ScoredItem(query="q", correctness=corr, hallucination=0.0, retrieval_precision=1.0,
                          citations_used=0, latency_ms=0.0, input_tokens=0, output_tokens=0, cost_usd=0.0,
                          category=cat, escalated=escalated, answer_changed=changed)

    def test_category_matrix(self):
        a = ArmRun("A", [self._scored("overview", 0.8), self._scored("label_lookup", 0.5)])
        c = ArmRun("C", [self._scored("overview", 0.9), self._scored("label_lookup", 0.95)])
        text = format_category_matrix([a, c], lambda si: si.correctness, "correctness")
        assert "overview" in text and "label_lookup" in text
        assert "A" in text and "C" in text
        assert "0.95" in text  # C label_lookup cell

    def test_escalation_stats(self):
        run = ArmRun("E", [
            self._scored("overview", 1.0, escalated=False),
            self._scored("chart", 0.5, escalated=True, changed=True),
            self._scored("chart", 0.6, escalated=True, changed=False),
        ])
        stats = escalation_stats(run)
        assert stats["n_escalated"] == 2
        assert stats["escalation_freq"] == pytest.approx(2 / 3, abs=1e-3)  # stat is rounded to 4dp
        assert stats["answer_change_rate_given_escalation"] == pytest.approx(0.5)
