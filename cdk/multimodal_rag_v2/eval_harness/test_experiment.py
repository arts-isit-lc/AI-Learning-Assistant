"""Tests for the Step 0 offline-experiment pure logic (prompts, parsing, arm/judge).

Deterministic: injected fake ops/invoke + a fake clock — no Bedrock, no S3.
"""
from __future__ import annotations

import pytest

from .experiment import (
    ANSWER_SYSTEM_BASELINE,
    ANSWER_SYSTEM_REVISED,
    ArmOps,
    build_answer_user_prompt,
    build_arm,
    build_judge_prompt,
    detect_media_type,
    extract_json,
    make_text_judge,
    parse_facts_response,
    parse_judge_response,
    perception_prompt_a,
    perception_prompt_b,
    perception_prompt_rich,
)
from .figure_dataset import FigureEvalItem
from .scoring import BedrockCall

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _item(**kw) -> FigureEvalItem:
    base = dict(
        query="What does Figure 1 show?", figure_ref="figure 1", image_s3_key="k/fig1.png",
        expected_figure_id="rid-1", ground_truth_facts=["fact a", "fact b"],
    )
    base.update(kw)
    return FigureEvalItem(**base)


class TestExtractJson:
    def test_plain(self):
        assert extract_json('{"a": 1}') == {"a": 1}

    def test_fenced(self):
        assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}

    def test_surrounding_prose_object(self):
        assert extract_json('Sure! {"a": 1} done') == {"a": 1}

    def test_array(self):
        assert extract_json("[1, 2, 3]") == [1, 2, 3]

    def test_no_json_raises(self):
        with pytest.raises(ValueError):
            extract_json("no json here")


class TestParsers:
    def test_parse_facts_array(self):
        assert parse_facts_response('["x", " y ", ""]') == ["x", "y"]

    def test_parse_facts_non_array_raises(self):
        with pytest.raises(ValueError):
            parse_facts_response('{"not": "an array"}')

    def test_parse_judge_clamps_and_reads_fields(self):
        js = parse_judge_response('{"correctness": 1.4, "hallucination": -0.2, "rationale": "ok"}')
        assert js.correctness == 1.0  # clamped
        assert js.hallucination == 0.0  # clamped
        assert js.rationale == "ok"

    def test_parse_judge_missing_fields_default_zero(self):
        js = parse_judge_response("{}")
        assert js.correctness == 0.0 and js.hallucination == 0.0


class TestMediaType:
    def test_png_jpeg_default(self):
        assert detect_media_type(PNG) == "image/png"
        assert detect_media_type(b"\xff\xd8\xff\xe0") == "image/jpeg"
        assert detect_media_type(b"unknown") == "image/png"  # default


class TestPrompts:
    def test_perception_a_is_query_aware(self):
        assert "What does Figure 1 show?" in perception_prompt_a(_item())

    def test_perception_b_is_short_and_query_agnostic(self):
        p = perception_prompt_b(_item())
        assert "1-3 sentences" in p
        assert "What does Figure 1 show?" not in p  # query-independent

    def test_perception_rich_is_query_agnostic_and_structured(self):
        p = perception_prompt_rich(_item())
        assert "What does Figure 1 show?" not in p
        assert "transcribed" in p.lower() and "do not answer" in p.lower()

    def test_answer_user_prompt_embeds_perception_and_query(self):
        u = build_answer_user_prompt("Q?", "PERCEPTION-TEXT")
        assert "PERCEPTION-TEXT" in u and "Q?" in u

    def test_judge_prompt_lists_facts_and_answer(self):
        p = build_judge_prompt("Q?", "the answer", ["f1", "f2"])
        assert "f1" in p and "f2" in p and "the answer" in p and "correctness" in p


class TestBuildArm:
    def test_composes_perceive_then_answer_and_records_calls(self):
        seen: dict = {}

        def fetch(key):
            assert key == "k/fig1.png"
            return (PNG, "image/png")

        def perceive(img, media_type, prompt):
            seen["perceive"] = (media_type, prompt)
            return ("PERCEPTION", BedrockCall("haiku", 10, 20))

        def answer(system, user):
            seen["answer"] = (system, user)
            return ("FINAL ANSWER", BedrockCall("sonnet", 30, 40))

        ops = ArmOps(fetch_image=fetch, perceive=perceive, answer=answer)
        clock = iter([1.0, 1.5]).__next__  # 0.5s -> 500 ms
        arm = build_arm(perception_prompt_b, ANSWER_SYSTEM_BASELINE, ops, clock=clock)

        out = arm(_item())
        assert out.answer == "FINAL ANSWER"
        assert out.latency_ms == 500.0
        assert [c.model_id for c in out.calls] == ["haiku", "sonnet"]
        assert out.source_ids == []  # no retrieval in the offline proxy
        # perception prompt B was used, and its output fed the answer step
        assert "1-3 sentences" in seen["perceive"][1]
        assert seen["answer"][0] == ANSWER_SYSTEM_BASELINE
        assert "PERCEPTION" in seen["answer"][1]

    def test_revised_answer_prompt_is_used_for_arm_d(self):
        seen: dict = {}

        def answer(system, user):
            seen["sys"] = system
            return ("A", BedrockCall("sonnet", 1, 1))

        ops = ArmOps(
            fetch_image=lambda k: (PNG, "image/png"),
            perceive=lambda i, m, p: ("PX", BedrockCall("haiku", 1, 1)),
            answer=answer,
        )
        arm = build_arm(perception_prompt_rich, ANSWER_SYSTEM_REVISED, ops, clock=iter([0.0, 0.1]).__next__)
        arm(_item())
        assert seen["sys"] == ANSWER_SYSTEM_REVISED


class TestMakeTextJudge:
    def test_parses_judge_json(self):
        judge = make_text_judge(lambda prompt: '{"correctness": 0.8, "hallucination": 0.1, "rationale": "r"}')
        js = judge("q", "a", ["f"])
        assert js.correctness == pytest.approx(0.8)
        assert js.hallucination == pytest.approx(0.1)

    def test_unparseable_response_scores_zero(self):
        judge = make_text_judge(lambda prompt: "the model rambled with no json")
        js = judge("q", "a", ["f"])
        assert js.correctness == 0.0 and js.hallucination == 0.0
        assert "judge parse failed" in js.rationale
