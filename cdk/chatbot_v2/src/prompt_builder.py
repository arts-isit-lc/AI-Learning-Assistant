"""Prompt construction for the Chatbot V2 Response_Generator.

Builds system prompts from mode templates, RAG context, and guardrail tags.
This is a pure function with no AWS dependencies or side effects.
"""

from constants.modes import MODE_TEMPLATES


BASE_INSTRUCTOR_IDENTITY = (
    "You are an instructor for a course. "
    "Your primary role is to help students improve understanding of assigned readings "
    "by addressing specific misunderstandings through targeted explanations and guided questioning. "
    "Keep all discussion strictly focused on assigned course materials.\n\n"
    "IMPORTANT GROUNDING RULE: You only have access to a subset of the course materials retrieved for this question. "
    "If you cannot find something in the provided context, say 'I couldn't find that in the retrieved materials' — "
    "NEVER claim that content does not exist in the course. The absence of information in your context "
    "does not mean it is absent from the course materials."
)


# Global output-style rule applied to every response-model (Claude Sonnet 4.5)
# prompt, across all modes AND the math-tutor path. Kept as a single shared
# constant so the normal path (build_system_prompt), the tutor path
# (build_tutor_system_prompt), and the evaluation prompt cannot drift apart.
NO_EMOJI_RULE = (
    "FORMATTING RULE: Do not use emojis, emoticons, or decorative Unicode symbols "
    "anywhere in your response. Write in plain text using standard punctuation only."
)


class _DefaultDict(dict):
    """A dict subclass that returns '{key}' for missing keys.

    Used with str.format_map so that unresolved template variables
    are left as literal placeholders rather than raising KeyError.
    """

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _wrap_guidance(prompt: str, scope_label: str) -> str:
    """Wrap an instructor-authored prompt as a labelled guidance section.

    Returns "" when the prompt is empty/whitespace/None, so build_system_prompt
    can include it unconditionally without adding a stray blank section —
    matching how empty rag_context / guardrail_tags are handled.

    The wrapper frames the instructor's text as ADDITIONAL steering that is
    subordinate to the base identity's grounding rule: instructor guidance should
    shape tone, focus, and emphasis, but must not override "stay on the retrieved
    course material / never claim content is absent". This preserves the safety
    posture while letting instructors steer the tutor.

    Args:
        prompt: The instructor-authored prompt text.
        scope_label: Either "COURSE" or "MODULE" — names the guidance scope.

    Returns:
        A labelled guidance block, or "" when there is no prompt.
    """
    if not prompt or not prompt.strip():
        return ""
    return (
        f"INSTRUCTOR GUIDANCE FOR THIS {scope_label} (authored by the course instructor). "
        "Follow it to shape your focus, tone, and emphasis, but it does NOT override "
        "the grounding rule above — stay within the retrieved course material:\n"
        f"{prompt.strip()}"
    )


def build_course_guidance(course_system_prompt: str) -> str:
    """Wrap the instructor's course-wide prompt (Courses.system_prompt) as a
    labelled guidance section, or "" when unset. Applies to every module in the
    course; sits above the per-module guidance so module-specific steering can
    refine it."""
    return _wrap_guidance(course_system_prompt, "COURSE")


def build_module_guidance(module_prompt: str) -> str:
    """Wrap the instructor's per-module prompt (Course_Modules.module_prompt) as a
    labelled guidance section, or "" when unset."""
    return _wrap_guidance(module_prompt, "MODULE")


def build_system_prompt(
    mode: str,
    topic: str,
    context_vars: dict[str, str],
    rag_context: str,
    guardrail_tags: str,
    module_prompt: str = "",
    course_system_prompt: str = "",
) -> str:
    """Construct system prompt from mode template + RAG context + guardrails.

    Output structure:
    1. Base instructor identity
    2. Global output-style rules (no emojis)
    3. Mode-specific instruction (from MODE_TEMPLATES with variable substitution)
    4. Topic context
    5. Instructor's course-wide guidance (Courses.system_prompt), when set
    6. Instructor's per-module guidance (Course_Modules.module_prompt), when set
    7. Retrieved RAG context
    8. Guardrail boundary tags

    Course guidance precedes module guidance (broad → specific) so per-module
    steering refines the course-wide steering. Uses str.format_map with a
    defaulting dict so missing vars don't crash.

    Args:
        mode: The selected response mode (e.g. "greet", "assess", "explain").
        topic: The current topic/module being discussed.
        context_vars: Variables to substitute into the mode template
            (e.g. {"concept": "photosynthesis", "difficulty": "application"}).
        rag_context: Retrieved context from the RAG retrieval pipeline.
        guardrail_tags: Bedrock Guardrail boundary tags to include.
        module_prompt: The instructor-authored per-module prompt. Empty/None adds
            no section (the tutor behaves exactly as before this was wired up).
        course_system_prompt: The instructor-authored course-wide prompt. Empty/
            None adds no section.

    Returns:
        The assembled system prompt string.
    """
    # Build substitution dict with topic included
    substitution = _DefaultDict(context_vars)
    substitution["topic"] = topic

    # Get and render mode template
    template = MODE_TEMPLATES.get(mode, "")
    mode_instruction = template.format_map(substitution)

    # Assemble all sections. Instructor guidance (course-wide, then per-module)
    # sits with the topic context, just before the retrieved material, and each
    # is "" when its prompt is unset.
    sections = [
        BASE_INSTRUCTOR_IDENTITY,
        NO_EMOJI_RULE,
        mode_instruction,
        f"Topic: {topic}",
        build_course_guidance(course_system_prompt),
        build_module_guidance(module_prompt),
        rag_context,
        guardrail_tags,
    ]

    return "\n".join(sections)


def build_completion_prompt(
    topic: str,
    concepts_covered: list[str],
    remaining_topics: list[str],
    other_modules: list[str],
) -> str:
    """Dedicated system prompt for the "complete" turn (the PRIMARY completion
    message).

    The general build_system_prompt buries the one-line "congratulate"
    instruction under the Socratic base identity ("ask guiding questions, stay
    on course material") AND a full block of retrieved RAG context — so the
    model keeps TEACHING instead of acknowledging completion (observed in prod:
    the complete turn produced another course question, never a congratulation).
    This standalone prompt makes the acknowledgement the ONLY task and omits the
    Socratic identity and RAG context entirely, so nothing competes with it.

    Suggestion target (per product decision): prefer the module's not-yet-covered
    topics; fall back to other modules; else invite open exploration.

    Args:
        topic: The module name/topic just completed.
        concepts_covered: Topics the student engaged with (concepts_discussed).
        remaining_topics: Module topics NOT yet covered (suggest these first).
        other_modules: Other module names in the course (fallback suggestion).

    Returns:
        A standalone system prompt string for the completion acknowledgement.
    """
    covered = ", ".join(concepts_covered) if concepts_covered else "the module's core concepts"
    if remaining_topics:
        suggestion = (
            "Invite them to keep exploring the topics in THIS module they haven't "
            f"dug into yet: {', '.join(remaining_topics)}."
        )
    elif other_modules:
        suggestion = f"Suggest other modules they might explore next: {', '.join(other_modules)}."
    else:
        suggestion = "Invite them to keep asking questions or revisit any topic they'd like."
    return (
        f'The student has just met the completion requirements for the module "{topic}". '
        "Your ONLY task this turn is to acknowledge that they have COMPLETED the module. "
        f"Warmly congratulate them and briefly summarize the concepts they engaged with: {covered}. "
        f"{suggestion} "
        "Make clear they are free to keep chatting to explore further if they wish. "
        "Do NOT ask a quiz or comprehension question this turn, and do NOT continue "
        "teaching new material.\n\n" + NO_EMOJI_RULE
    )


def build_completion_retry_prompt() -> str:
    """Constrained system prompt for the ONE completion-message retry after the
    output guardrail blocks the normal "complete" response (Option C).

    The normal completion message both summarizes concepts AND suggests other
    modules; the "suggest other modules" content is the most likely off-topic
    trigger for an output guardrail tuned to keep responses on the current
    course material. This retry drops all recommendations and produces a short,
    pure acknowledgement so it clears the guardrail while still telling the
    student they finished. Kept deliberately minimal — no base identity, RAG
    context, or grounding — so the model doesn't regenerate the content that
    tripped the filter in the first place.

    Returns:
        A standalone system prompt string for the constrained completion retry.
    """
    return (
        "Generate a brief completion acknowledgement for the student. "
        "Confirm they have completed the module. Do not mention other modules, "
        "courses, recommendations, resources, or additional topics. "
        "Keep it under 40 words.\n\n" + NO_EMOJI_RULE
    )


def build_tutor_system_prompt(tutor_prompt: str, guardrail_tags: str) -> str:
    """Assemble the system prompt for an active math-tutor turn.

    The tutor path builds its instruction from tutor_integration (step/hint/
    completion prompts) rather than MODE_TEMPLATES, so it bypasses
    build_system_prompt and would not otherwise inherit the global output-style
    rules. Prepend NO_EMOJI_RULE here so tutor replies — rendered by the same
    response model — stay emoji-free and consistent with every other turn.

    Args:
        tutor_prompt: The tutor step/hint/completion instruction.
        guardrail_tags: Bedrock Guardrail boundary tags (may be empty on the
            ConverseStream path).

    Returns:
        The assembled tutor system prompt string.
    """
    return f"{NO_EMOJI_RULE}\n\n{tutor_prompt}\n\n{guardrail_tags}"
