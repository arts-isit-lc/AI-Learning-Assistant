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
    2. Mode-specific instruction (from MODE_TEMPLATES with variable substitution)
    3. Topic context
    4. Retrieved RAG context
    5. Guardrail boundary tags

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

    # Assemble all five sections
    sections = [
        BASE_INSTRUCTOR_IDENTITY,
        mode_instruction,
        f"Topic: {topic}",
        rag_context,
        guardrail_tags,
    ]

    return "\n".join(sections)
