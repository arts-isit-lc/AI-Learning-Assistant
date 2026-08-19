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
    build_course_guidance,
    build_module_guidance,
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


class TestModulePromptInjection:
    """The instructor's per-module prompt (Course_Modules.module_prompt) steers
    the normal teaching turns via build_system_prompt."""

    INSTRUCTOR_PROMPT = "Emphasize real-world civil-engineering examples and use metric units."

    def test_module_prompt_text_appears_in_system_prompt(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={"concept": "free body diagrams"},
            rag_context="Some retrieved context.",
            guardrail_tags="",
            module_prompt=self.INSTRUCTOR_PROMPT,
        )
        assert self.INSTRUCTOR_PROMPT in prompt

    def test_module_prompt_is_framed_as_instructor_guidance(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="",
            guardrail_tags="",
            module_prompt=self.INSTRUCTOR_PROMPT,
        )
        # Labelled so the model treats it as instructor steering, and framed as
        # subordinate to the grounding rule (it must not override staying on the
        # retrieved course material).
        assert "INSTRUCTOR GUIDANCE FOR THIS MODULE" in prompt
        assert "does NOT override" in prompt

    def test_module_prompt_placed_after_topic_before_rag_context(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="RAG_CONTEXT_MARKER",
            guardrail_tags="",
            module_prompt=self.INSTRUCTOR_PROMPT,
        )
        # Ordering contract: Topic -> instructor guidance -> retrieved context.
        assert prompt.index("Topic: Statics") < prompt.index(self.INSTRUCTOR_PROMPT)
        assert prompt.index(self.INSTRUCTOR_PROMPT) < prompt.index("RAG_CONTEXT_MARKER")

    def test_empty_module_prompt_adds_no_guidance_section(self):
        # Back-compat: with no module prompt the tutor behaves exactly as before
        # this was wired up — no guidance label leaks into the prompt.
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="ctx",
            guardrail_tags="",
            module_prompt="",
        )
        assert "INSTRUCTOR GUIDANCE FOR THIS MODULE" not in prompt

    def test_module_prompt_defaults_to_empty_when_omitted(self):
        # The parameter is optional; existing call sites that omit it must not
        # gain a guidance section.
        prompt = build_system_prompt(
            mode="assess",
            topic="Statics",
            context_vars={"difficulty": "application"},
            rag_context="ctx",
            guardrail_tags="",
        )
        assert "INSTRUCTOR GUIDANCE FOR THIS MODULE" not in prompt

    def test_whitespace_only_module_prompt_is_ignored(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="ctx",
            guardrail_tags="",
            module_prompt="   \n\t ",
        )
        assert "INSTRUCTOR GUIDANCE FOR THIS MODULE" not in prompt


class TestCoursePromptInjection:
    """The instructor's course-wide prompt (Courses.system_prompt) steers every
    module's normal teaching turns via build_system_prompt."""

    COURSE_PROMPT = "Address students formally and cite the textbook edition when relevant."

    def test_course_prompt_text_appears_in_system_prompt(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="ctx",
            guardrail_tags="",
            course_system_prompt=self.COURSE_PROMPT,
        )
        assert self.COURSE_PROMPT in prompt

    def test_course_prompt_is_framed_as_instructor_guidance(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="",
            guardrail_tags="",
            course_system_prompt=self.COURSE_PROMPT,
        )
        assert "INSTRUCTOR GUIDANCE FOR THIS COURSE" in prompt
        assert "does NOT override" in prompt

    def test_empty_course_prompt_adds_no_guidance_section(self):
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="ctx",
            guardrail_tags="",
            course_system_prompt="",
        )
        assert "INSTRUCTOR GUIDANCE FOR THIS COURSE" not in prompt

    def test_course_prompt_defaults_to_empty_when_omitted(self):
        prompt = build_system_prompt(
            mode="assess",
            topic="Statics",
            context_vars={"difficulty": "application"},
            rag_context="ctx",
            guardrail_tags="",
        )
        assert "INSTRUCTOR GUIDANCE FOR THIS COURSE" not in prompt

    def test_course_guidance_precedes_module_guidance(self):
        # Broad -> specific: course-wide steering comes before per-module steering
        # (which refines it), and both precede the retrieved context.
        prompt = build_system_prompt(
            mode="explain",
            topic="Statics",
            context_vars={},
            rag_context="RAG_MARKER",
            guardrail_tags="",
            module_prompt="Use metric units.",
            course_system_prompt=self.COURSE_PROMPT,
        )
        i_course = prompt.index("INSTRUCTOR GUIDANCE FOR THIS COURSE")
        i_module = prompt.index("INSTRUCTOR GUIDANCE FOR THIS MODULE")
        i_topic = prompt.index("Topic: Statics")
        i_rag = prompt.index("RAG_MARKER")
        assert i_topic < i_course < i_module < i_rag


class TestBuildGuidanceHelpers:
    """Unit tests for the guidance-wrapper helpers in isolation."""

    def test_module_returns_empty_for_blank_inputs(self):
        assert build_module_guidance("") == ""
        assert build_module_guidance("   ") == ""
        assert build_module_guidance(None) == ""

    def test_course_returns_empty_for_blank_inputs(self):
        assert build_course_guidance("") == ""
        assert build_course_guidance("   ") == ""
        assert build_course_guidance(None) == ""

    def test_module_wraps_and_strips_prompt(self):
        out = build_module_guidance("  Focus on proofs.  ")
        assert out.startswith("INSTRUCTOR GUIDANCE FOR THIS MODULE")
        assert "Focus on proofs." in out
        # Leading/trailing whitespace of the instructor text is trimmed.
        assert "  Focus on proofs.  " not in out

    def test_course_wraps_and_strips_prompt(self):
        out = build_course_guidance("  Be formal.  ")
        assert out.startswith("INSTRUCTOR GUIDANCE FOR THIS COURSE")
        assert "Be formal." in out
        assert "  Be formal.  " not in out


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
