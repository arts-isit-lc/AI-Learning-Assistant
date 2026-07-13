"""Tutor Runtime — state machine for step-by-step interactive tutoring.

Manages: step progression, hints, revelation, and mode transitions.
All state updates are deterministic (not LLM-driven).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from step_generator import SolutionStep
from rewrite_rules import validate_step


MAX_STUCK_COUNT = 2  # reveal step after this many failed attempts


@dataclass
class TutorState:
    """Persistent state for a tutoring session (stored in DynamoDB)."""
    active: bool = False
    current_step_index: int = 0
    stuck_count: int = 0
    mode: str = "socratic"  # socratic | direct | verify_only
    step_list: list[dict] = field(default_factory=list)
    final_answer: dict = field(default_factory=dict)
    operation: str = ""
    completed: bool = False

    def to_dict(self) -> dict:
        return {
            "active": self.active,
            "current_step_index": self.current_step_index,
            "stuck_count": self.stuck_count,
            "mode": self.mode,
            "step_list": self.step_list,
            "final_answer": self.final_answer,
            "operation": self.operation,
            "completed": self.completed,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "TutorState":
        return cls(
            active=data.get("active", False),
            current_step_index=data.get("current_step_index", 0),
            stuck_count=data.get("stuck_count", 0),
            mode=data.get("mode", "socratic"),
            step_list=data.get("step_list", []),
            final_answer=data.get("final_answer", {}),
            operation=data.get("operation", ""),
            completed=data.get("completed", False),
        )


@dataclass
class TutorAction:
    """Action for the LLM renderer to execute."""
    action_type: str  # present_step | confirm_advance | give_hint | reveal_step | present_answer | request_clarification | verify_result
    message: str = ""
    step: dict | None = None
    final_answer: dict | None = None
    is_complete: bool = False


def initialize_tutor(steps: list[SolutionStep], final_answer: dict, operation: str) -> TutorState:
    """Create initial tutor state from generated steps.

    Args:
        steps: Canonical solution steps from step_generator.
        final_answer: Verified SymPy result.
        operation: The math operation being tutored.

    Returns:
        New TutorState ready for first interaction.
    """
    return TutorState(
        active=True,
        current_step_index=0,
        stuck_count=0,
        mode="socratic",
        step_list=[s.to_dict() for s in steps],
        final_answer=final_answer,
        operation=operation,
        completed=False,
    )


def process_student_input(state: TutorState, student_input: str) -> tuple[TutorState, TutorAction]:
    """Process student input and return next tutor action.

    All state transitions are deterministic.

    Args:
        state: Current tutor state.
        student_input: What the student said/wrote.

    Returns:
        (updated_state, action_for_renderer)
    """
    # Handle mode switches
    lower_input = student_input.lower().strip()

    if _is_direct_request(lower_input):
        return _handle_direct_request(state)

    if _is_hint_request(lower_input):
        return _handle_hint_request(state)

    if state.mode == "direct":
        return _handle_direct_request(state)

    if state.completed:
        return state, TutorAction(
            action_type="present_answer",
            message="We already completed this problem! The verified answer is:",
            final_answer=state.final_answer,
            is_complete=True,
        )

    # Socratic mode: validate student's attempt against current step
    return _handle_step_attempt(state, student_input)


def get_initial_prompt(state: TutorState) -> TutorAction:
    """Get the initial tutoring prompt (first step question).

    Args:
        state: Fresh tutor state.

    Returns:
        Action presenting the first step.
    """
    if not state.step_list:
        return TutorAction(
            action_type="present_answer",
            message="I have the verified answer:",
            final_answer=state.final_answer,
            is_complete=True,
        )

    first_step = state.step_list[0]
    return TutorAction(
        action_type="present_step",
        message=f"Let's work through this step by step. {first_step['description']}",
        step=first_step,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Internal handlers
# ──────────────────────────────────────────────────────────────────────────────

def _handle_step_attempt(state: TutorState, student_input: str) -> tuple[TutorState, TutorAction]:
    """Handle student's attempt at the current step."""
    if state.current_step_index >= len(state.step_list):
        # All steps complete
        state.completed = True
        return state, TutorAction(
            action_type="present_answer",
            message="Excellent! You've worked through all the steps. The verified final answer is:",
            final_answer=state.final_answer,
            is_complete=True,
        )

    current_step = state.step_list[state.current_step_index]
    expected_output = current_step["expected_output"]

    # Get previous step output for rewrite validation
    prev_output = ""
    if state.current_step_index > 0:
        prev_output = state.step_list[state.current_step_index - 1]["expected_output"]

    # Validate student attempt
    is_valid, feedback = validate_step(prev_output, student_input, expected_output)

    if is_valid:
        # Correct — advance
        state.current_step_index += 1
        state.stuck_count = 0

        if state.current_step_index >= len(state.step_list):
            state.completed = True
            return state, TutorAction(
                action_type="confirm_advance",
                message=f"✅ {feedback} Great work! You've completed all steps. The verified final answer is:",
                final_answer=state.final_answer,
                is_complete=True,
            )
        else:
            next_step = state.step_list[state.current_step_index]
            return state, TutorAction(
                action_type="confirm_advance",
                message=f"✅ {feedback} Now, {next_step['description']}",
                step=next_step,
            )
    else:
        # Incorrect — increment stuck count
        state.stuck_count += 1

        if state.stuck_count >= MAX_STUCK_COUNT:
            # Reveal and advance
            state.current_step_index += 1
            state.stuck_count = 0

            reveal_msg = f"No worries! The answer for this step is: **{expected_output}**"

            if state.current_step_index >= len(state.step_list):
                state.completed = True
                return state, TutorAction(
                    action_type="reveal_step",
                    message=f"{reveal_msg}\n\nYou've reached the end. The verified final answer is:",
                    final_answer=state.final_answer,
                    is_complete=True,
                )
            else:
                next_step = state.step_list[state.current_step_index]
                return state, TutorAction(
                    action_type="reveal_step",
                    message=f"{reveal_msg}\n\nLet's continue. {next_step['description']}",
                    step=next_step,
                )
        else:
            # Give hint
            hint = current_step.get("hint", "Try again carefully.")
            return state, TutorAction(
                action_type="give_hint",
                message=f"{feedback}\n\n💡 Hint: {hint}",
                step=current_step,
            )


def _handle_direct_request(state: TutorState) -> tuple[TutorState, TutorAction]:
    """Student asked for the answer directly."""
    state.mode = "direct"
    state.completed = True
    return state, TutorAction(
        action_type="present_answer",
        message="Here's the complete verified solution:",
        final_answer=state.final_answer,
        step=None,
        is_complete=True,
    )


def _handle_hint_request(state: TutorState) -> tuple[TutorState, TutorAction]:
    """Student explicitly asked for a hint."""
    if state.current_step_index >= len(state.step_list):
        return _handle_direct_request(state)

    current_step = state.step_list[state.current_step_index]
    hint = current_step.get("hint", "Review the step description carefully.")
    return state, TutorAction(
        action_type="give_hint",
        message=f"💡 Hint: {hint}",
        step=current_step,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Intent detection (deterministic, not LLM)
# ──────────────────────────────────────────────────────────────────────────────

def _is_direct_request(text: str) -> bool:
    """Detect if student wants the answer immediately."""
    triggers = [
        "just tell me", "give me the answer", "what's the answer",
        "show me the answer", "skip", "i give up", "just show me",
    ]
    return any(t in text for t in triggers)


def _is_hint_request(text: str) -> bool:
    """Detect if student wants a hint."""
    triggers = ["hint", "help", "i'm stuck", "im stuck", "give me a clue"]
    return any(t in text for t in triggers)
