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


def build_system_prompt(
    mode: str,
    topic: str,
    context_vars: dict[str, str],
    rag_context: str,
    guardrail_tags: str,
) -> str:
    """Construct system prompt from mode template + RAG context + guardrails.

    Output structure:
    1. Base instructor identity
    2. Global output-style rules (no emojis)
    3. Mode-specific instruction (from MODE_TEMPLATES with variable substitution)
    4. Topic context
    5. Retrieved RAG context
    6. Guardrail boundary tags

    Uses str.format_map with a defaulting dict so missing vars don't crash.

    Args:
        mode: The selected response mode (e.g. "greet", "assess", "explain").
        topic: The current topic/module being discussed.
        context_vars: Variables to substitute into the mode template
            (e.g. {"concept": "photosynthesis", "difficulty": "application"}).
        rag_context: Retrieved context from the RAG retrieval pipeline.
        guardrail_tags: Bedrock Guardrail boundary tags to include.

    Returns:
        The assembled system prompt string with all five sections.
    """
    # Build substitution dict with topic included
    substitution = _DefaultDict(context_vars)
    substitution["topic"] = topic

    # Get and render mode template
    template = MODE_TEMPLATES.get(mode, "")
    mode_instruction = template.format_map(substitution)

    # Assemble all sections
    sections = [
        BASE_INSTRUCTOR_IDENTITY,
        NO_EMOJI_RULE,
        mode_instruction,
        f"Topic: {topic}",
        rag_context,
        guardrail_tags,
    ]

    return "\n".join(sections)


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
