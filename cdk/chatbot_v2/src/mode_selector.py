"""Mode selection logic for Chatbot V2.

Implements the decision table that maps session state and evaluation results
to a response mode. The mode determines how the Response_Generator LLM will
respond (greet, assess, hint, explain, advance, complete, or post_completion).

This is a pure function with no AWS dependencies or side effects.
"""

from typing import Literal

from state_machine import SessionState
from evaluation import EvaluationResult

Mode = Literal[
    "greet",
    "assess",
    "hint_nudge",
    "hint_scaffold",
    "explain",
    "advance",
    "complete",
    "post_completion",
]


def select_mode(
    state: SessionState, evaluation: EvaluationResult | None, advanced: bool
) -> Mode:
    """Select response mode based on state and evaluation.

    Decision table (evaluated in priority order):
    1. state.completion_message_sent == True → "post_completion" (HIGHEST PRIORITY)
    2. state.module_complete == True AND state.completion_message_sent == False → "complete"
    3. state.interactions == 0 → "greet"
    4. evaluation.correct AND advanced → "advance"
    5. evaluation.correct AND NOT advanced → "assess"
    6. evaluation.partial AND state.hint_level == 0 → "hint_nudge"
    7. evaluation.partial AND state.hint_level >= 1 → "hint_scaffold"
    8. NOT correct AND state.consecutive_failures >= 3 → "explain"
    9. NOT correct AND state.hint_level < 2 → "hint_scaffold"
    10. fallback → "explain"

    Args:
        state: Current session state including completion flags, interaction
            count, hint_level, and consecutive_failures.
        evaluation: The evaluation result from the current interaction,
            or None if this is the first message (no prior answer to evaluate).
        advanced: Whether the state machine determined a stage advancement
            occurred this interaction.

    Returns:
        The selected mode string that determines the Response_Generator's
        behavior.
    """
    # 1. Post-completion has highest priority — prevents re-triggering congratulations
    if state.completion_message_sent:
        return "post_completion"

    # 2. Module just completed — fire congratulatory message exactly once
    if state.module_complete and not state.completion_message_sent:
        return "complete"

    # 3. First interaction — greet the student
    if state.interactions == 0:
        return "greet"

    # 4-10. Evaluation-based decisions (evaluation should not be None at this point,
    # but guard defensively)
    if evaluation is None:
        return "assess"

    # 4. Correct answer with stage advancement
    if evaluation.correct and advanced:
        return "advance"

    # 5. Correct answer without stage advancement
    if evaluation.correct and not advanced:
        return "assess"

    # 6. Partial answer at hint_level 0
    if evaluation.partial and state.hint_level == 0:
        return "hint_nudge"

    # 7. Partial answer at hint_level >= 1
    if evaluation.partial and state.hint_level >= 1:
        return "hint_scaffold"

    # 8-10. Incorrect answer (not correct, not partial)
    # 8. High consecutive failures — explain
    if state.consecutive_failures >= 3:
        return "explain"

    # 9. Low hint level — scaffold
    if state.hint_level < 2:
        return "hint_scaffold"

    # 10. Fallback — explain
    return "explain"
