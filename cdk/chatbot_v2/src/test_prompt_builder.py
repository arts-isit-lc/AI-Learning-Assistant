"""Unit tests for prompt_builder.

Covers the two behaviours added for Claude 4.5 output consistency:
  1. The shared NO_EMOJI_RULE reaches every response-model prompt path
     (normal modes, the math-tutor path, and the Haiku evaluation prompt).
  2. The new-chat "greet" template keeps the greeting and the opening question
     in a single paragraph (option A) so it renders as one <p> in react-markdown.

Pure functions / string constants only — no AWS calls, no network.
"""

import os
import sys

# Ensure the Lambda src dir is importable regardless of pytest invocation/cwd
# (mirrors the runtime layout where handlers use bare module imports).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from prompt_builder import (  # noqa: E402
    NO_EMOJI_RULE,
    build_system_prompt,
    build_tutor_system_prompt,
)
from constants.modes import MODE_TEMPLATES  # noqa: E402


class TestNoEmojiRuleConstant:
    """The shared rule is the single source of truth for emoji suppression."""

    def test_rule_mentions_emojis(self):
        assert "emoji" in NO_EMOJI_RULE.lower()

    def test_rule_is_plain_text_directive(self):
        assert "plain text" in NO_EMOJI_RULE.lower()


class TestBuildSystemPromptNoEmoji:
    """Every normal (non-tutor) mode inherits the no-emoji rule."""

    def test_assess_mode_includes_no_emoji_rule(self):
        prompt = build_system_prompt(
            mode="assess",
            topic="Photosynthesis",
            context_vars={"difficulty": "application", "concept": "light reactions"},
            rag_context="Some retrieved context.",
            guardrail_tags="",
        )
        assert NO_EMOJI_RULE in prompt

    def test_greet_mode_includes_no_emoji_rule(self):
        prompt = build_system_prompt(
            mode="greet",
            topic="Photosynthesis",
            context_vars={},
            rag_context="",
            guardrail_tags="",
        )
        assert NO_EMOJI_RULE in prompt

    def test_unknown_mode_still_includes_no_emoji_rule(self):
        # Missing template resolves to "" but the global rule must still apply.
        prompt = build_system_prompt(
            mode="does_not_exist",
            topic="Anything",
            context_vars={},
            rag_context="",
            guardrail_tags="",
        )
        assert NO_EMOJI_RULE in prompt


class TestBuildTutorSystemPrompt:
    """The math-tutor path bypasses build_system_prompt, so it needs the rule too."""

    def test_tutor_prompt_includes_no_emoji_rule(self):
        tutor_prompt = "MATH TUTORING MODE ACTIVE - present Step 1."
        prompt = build_tutor_system_prompt(tutor_prompt, guardrail_tags="")
        assert NO_EMOJI_RULE in prompt

    def test_tutor_prompt_preserves_instruction(self):
        tutor_prompt = "MATH TUTORING - STEP CORRECT. Present the next step."
        prompt = build_tutor_system_prompt(tutor_prompt, guardrail_tags="")
        assert tutor_prompt in prompt

    def test_tutor_prompt_preserves_guardrail_tags(self):
        tags = "<amazon-bedrock-guardrails-guardContent_xyz>hi</...>"
        prompt = build_tutor_system_prompt("do the step", guardrail_tags=tags)
        assert tags in prompt

    def test_tutor_prompt_empty_guardrail_tags_ok(self):
        # ConverseStream path passes "" — assembly must not raise or drop the rule.
        prompt = build_tutor_system_prompt("do the step", guardrail_tags="")
        assert NO_EMOJI_RULE in prompt
        assert "do the step" in prompt


class TestEvaluationPromptNoEmoji:
    """The Haiku evaluation prompt shares the same rule (defence in depth)."""

    def test_eval_prompt_includes_no_emoji_rule(self):
        from evaluation import EVALUATION_PROMPT

        assert NO_EMOJI_RULE in EVALUATION_PROMPT

    def test_eval_prompt_still_formattable(self):
        # Appending the rule must not break the .format() placeholders.
        from evaluation import EVALUATION_PROMPT

        rendered = EVALUATION_PROMPT.format(
            topic="t",
            stage="s",
            last_ai_question="q",
            student_answer="a",
            concepts="c",
            module_concepts="[]",
        )
        assert NO_EMOJI_RULE in rendered


class TestGreetSingleParagraph:
    """Option A: greeting + opening question rendered as one paragraph."""

    def test_greet_template_requests_single_paragraph(self):
        greet = MODE_TEMPLATES["greet"].lower()
        assert "paragraph" in greet
        # Explicitly forbids splitting the greeting onto its own line/paragraph.
        assert "separate line" in greet or "own paragraph" in greet

    def test_greet_template_still_asks_opening_question(self):
        greet_lower = MODE_TEMPLATES["greet"].lower()
        assert "question" in greet_lower
        # Topic placeholder must survive so build_system_prompt can substitute it.
        assert "{topic}" in MODE_TEMPLATES["greet"]
