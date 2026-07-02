"""Tutor integration — bridges math_compute tutor runtime with chatbot-v2.

Handles:
- Detecting when to enter tutoring mode (compute + explain intent with steps)
- Processing student turns through the tutor state machine
- Generating constrained prompts for the LLM renderer
- Managing tutor state lifecycle in session state
"""

from __future__ import annotations

import json
from typing import Any

from aws_lambda_powertools import Logger

from math_classifier import MathClassification
from math_compute_client import MathComputeResult

logger = Logger(service="chatbot-v2")


# ──────────────────────────────────────────────────────────────────────────────
# Tutor State (simplified version of tutor_runtime.TutorState for chatbot-v2)
# ──────────────────────────────────────────────────────────────────────────────

def create_tutor_state(compute_result: MathComputeResult) -> dict:
    """Create initial tutor state from a successful compute result with steps.

    Args:
        compute_result: Verified result with step list from math_compute Lambda.

    Returns:
        Tutor state dict for persistence in session state.
    """
    return {
        "active": True,
        "current_step_index": 0,
        "stuck_count": 0,
        "mode": "socratic",
        "step_list": compute_result.answer.get("_steps", []),
        "final_answer": compute_result.answer,
        "operation": compute_result.answer.get("_operation", ""),
        "completed": False,
    }


def is_tutor_active(session_state) -> bool:
    """Check if tutoring mode is currently active for this session."""
    tutor = session_state.tutor_state
    return bool(tutor and tutor.get("active") and not tutor.get("completed"))


def should_enter_tutoring(classification: MathClassification, compute_result: MathComputeResult | None) -> bool:
    """Determine if the chatbot should enter step-by-step tutoring mode.

    Enters tutoring when:
    - Classification has both compute and explain flags
    - Compute result is verified and has steps
    - Student didn't explicitly ask for just the answer

    Args:
        classification: Math intent classification.
        compute_result: Result from math_compute Lambda (may be None).

    Returns:
        True if tutoring mode should be activated.
    """
    if compute_result is None:
        return False
    # Only enter step-by-step tutoring on a VERIFIED result (M14). A "partial"
    # result is inconclusive, and the tutoring/direct-answer prompts assert the
    # values are verified — so partials must stay on the V1 injection path (which
    # labels them as needing a double-check) rather than being framed as verified.
    if compute_result.status != "verified":
        return False
    if not compute_result.answer.get("_steps"):
        return False
    if classification.explain:
        return True
    # Default: if compute succeeded with steps, offer tutoring
    return classification.compute and classification.has_explicit_math


def process_tutor_turn(tutor_state: dict, student_input: str) -> tuple[dict, str]:
    """Process a student message through the tutor state machine.

    Deterministic state transitions based on student input.

    Args:
        tutor_state: Current tutor state from session.
        student_input: What the student said.

    Returns:
        (updated_tutor_state, prompt_for_llm)
    """
    lower_input = student_input.lower().strip()

    # Direct request — show full answer
    if _is_direct_request(lower_input):
        tutor_state["mode"] = "direct"
        tutor_state["completed"] = True
        return tutor_state, _build_direct_answer_prompt(tutor_state)

    # Hint request
    if _is_hint_request(lower_input):
        return tutor_state, _build_hint_prompt(tutor_state)

    # Already completed
    if tutor_state.get("completed"):
        tutor_state["active"] = False
        return tutor_state, ""

    # Validate student's attempt against current step
    return _process_step_attempt(tutor_state, student_input)


def get_initial_tutor_prompt(tutor_state: dict) -> str:
    """Generate the initial tutoring prompt (presents first step).

    Args:
        tutor_state: Freshly created tutor state.

    Returns:
        Prompt injection for the LLM to present the first step.
    """
    steps = tutor_state.get("step_list", [])
    if not steps:
        return _build_direct_answer_prompt(tutor_state)

    first_step = steps[0]
    operation = tutor_state.get("operation", "this problem")

    return (
        f"MATH TUTORING MODE ACTIVE — GUIDED STEP-BY-STEP\n\n"
        f"You are guiding the student through {operation}.\n"
        f"Present Step 1 and ask the student to attempt it.\n\n"
        f"Step 1: {first_step['description']}\n"
        f"(Expected answer: {first_step['expected_output']})\n\n"
        f"RULES:\n"
        f"- Ask the student to attempt this step\n"
        f"- Do NOT reveal the expected answer yet\n"
        f"- You may rephrase the step description in natural language\n"
        f"- Do NOT introduce any new mathematical formulas\n"
    )


# ──────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────────────────────────────────────

MAX_STUCK = 2


def _process_step_attempt(tutor_state: dict, student_input: str) -> tuple[dict, str]:
    """Validate student attempt against current step."""
    steps = tutor_state.get("step_list", [])
    idx = tutor_state.get("current_step_index", 0)

    if idx >= len(steps):
        tutor_state["completed"] = True
        return tutor_state, _build_completion_prompt(tutor_state)

    current_step = steps[idx]
    expected = current_step["expected_output"]

    # Simple validation: check if student's answer contains key elements
    # Full SymPy validation happens in the math_compute Lambda for complex cases
    # Here we do lightweight string matching for the chatbot flow
    is_correct = _lightweight_validate(student_input, expected)

    if is_correct:
        # Advance
        tutor_state["current_step_index"] = idx + 1
        tutor_state["stuck_count"] = 0

        if idx + 1 >= len(steps):
            tutor_state["completed"] = True
            return tutor_state, _build_completion_prompt(tutor_state)
        else:
            next_step = steps[idx + 1]
            return tutor_state, (
                f"MATH TUTORING — STEP CORRECT\n\n"
                f"The student's answer for Step {idx + 1} is correct.\n"
                f"Confirm their answer and present the next step.\n\n"
                f"Their answer: {student_input}\n"
                f"Expected: {expected}\n\n"
                f"Next Step {idx + 2}: {next_step['description']}\n"
                f"(Expected answer: {next_step['expected_output']})\n\n"
                f"RULES:\n"
                f"- Confirm they got it right (briefly)\n"
                f"- Present the next step and ask them to attempt it\n"
                f"- Do NOT reveal the next expected answer\n"
            )
    else:
        # Incorrect — increment stuck count
        tutor_state["stuck_count"] = tutor_state.get("stuck_count", 0) + 1

        if tutor_state["stuck_count"] >= MAX_STUCK:
            # Reveal and advance
            tutor_state["current_step_index"] = idx + 1
            tutor_state["stuck_count"] = 0

            if idx + 1 >= len(steps):
                tutor_state["completed"] = True
                return tutor_state, (
                    f"MATH TUTORING — REVEALING STEP + COMPLETE\n\n"
                    f"The student struggled with Step {idx + 1}. Reveal the answer and show the final result.\n\n"
                    f"Step {idx + 1} answer: {expected}\n"
                    f"Final verified answer: {json.dumps(tutor_state.get('final_answer', {}))}\n\n"
                    f"RULES:\n"
                    f"- Show the step answer kindly ('The answer here is...')\n"
                    f"- Present the final verified result\n"
                    f"- Do NOT introduce new math\n"
                )
            else:
                next_step = steps[idx + 1]
                return tutor_state, (
                    f"MATH TUTORING — REVEALING STEP\n\n"
                    f"The student struggled with Step {idx + 1} after {MAX_STUCK} attempts. Reveal it and move on.\n\n"
                    f"Step {idx + 1} answer: {expected}\n"
                    f"Next Step {idx + 2}: {next_step['description']}\n"
                    f"(Expected: {next_step['expected_output']})\n\n"
                    f"RULES:\n"
                    f"- Reveal Step {idx + 1} answer kindly\n"
                    f"- Present next step\n"
                    f"- Do NOT reveal next step's answer\n"
                )
        else:
            # Give hint
            hint = current_step.get("hint", "Review the step description carefully.")
            return tutor_state, (
                f"MATH TUTORING — INCORRECT ATTEMPT\n\n"
                f"The student's attempt at Step {idx + 1} was incorrect.\n"
                f"Their attempt: {student_input}\n"
                f"Expected: {expected}\n"
                f"Hint to give: {hint}\n\n"
                f"RULES:\n"
                f"- Tell them their answer isn't quite right (don't say 'wrong')\n"
                f"- Provide the hint above in natural language\n"
                f"- Ask them to try again\n"
                f"- Do NOT reveal the expected answer\n"
            )


def _build_direct_answer_prompt(tutor_state: dict) -> str:
    """Build prompt for direct answer mode."""
    final = tutor_state.get("final_answer", {})
    steps = tutor_state.get("step_list", [])

    steps_text = "\n".join(
        f"  Step {s['step_id']}: {s['description']} → {s['expected_output']}"
        for s in steps
    )

    return (
        f"MATH TUTORING — DIRECT ANSWER MODE\n\n"
        f"The student requested the full answer. Present the verified solution:\n\n"
        f"Solution steps:\n{steps_text}\n\n"
        f"Final answer: {json.dumps(final)}\n\n"
        f"RULES:\n"
        f"- Present the complete solution clearly\n"
        f"- Show each step with its result\n"
        f"- End with the verified final answer\n"
        f"- All values are verified — reproduce EXACTLY\n"
    )


def _build_hint_prompt(tutor_state: dict) -> str:
    """Build prompt for hint request."""
    steps = tutor_state.get("step_list", [])
    idx = tutor_state.get("current_step_index", 0)

    if idx >= len(steps):
        return _build_direct_answer_prompt(tutor_state)

    current_step = steps[idx]
    hint = current_step.get("hint", "Think about what operation to apply here.")

    return (
        f"MATH TUTORING — HINT REQUESTED\n\n"
        f"Student asked for help on Step {idx + 1}: {current_step['description']}\n"
        f"Hint: {hint}\n\n"
        f"RULES:\n"
        f"- Provide the hint in natural, encouraging language\n"
        f"- Do NOT reveal the expected answer\n"
        f"- Ask them to try again after the hint\n"
    )


def _build_completion_prompt(tutor_state: dict) -> str:
    """Build prompt for successful completion."""
    final = tutor_state.get("final_answer", {})
    return (
        f"MATH TUTORING — COMPLETE\n\n"
        f"The student successfully worked through all steps!\n"
        f"Final verified answer: {json.dumps(final)}\n\n"
        f"RULES:\n"
        f"- Congratulate them on completing the problem\n"
        f"- State the verified final answer\n"
        f"- Offer to help with another problem or explain any step further\n"
    )


def _lightweight_validate(student_input: str, expected: str) -> bool:
    """Lightweight validation for chatbot flow.

    Checks if the student's answer contains key numeric/symbolic elements
    from the expected output. Not a full SymPy equivalence check —
    that happens in the math_compute Lambda for complex cases.

    Args:
        student_input: What the student typed.
        expected: Expected step output string.

    Returns:
        True if the student's answer appears correct.
    """
    # Normalize both
    student_clean = student_input.strip().replace(" ", "").lower()
    expected_clean = expected.strip().replace(" ", "").lower()

    # Exact match (after normalization)
    if student_clean == expected_clean:
        return True

    # Check if key numeric values from expected appear in student answer
    import re
    numbers_in_expected = re.findall(r'-?\d+\.?\d*', expected)
    if numbers_in_expected:
        matches = sum(1 for n in numbers_in_expected if n in student_input)
        # If most key numbers are present, likely correct
        if matches >= len(numbers_in_expected) * 0.7:
            return True

    # Check if expected is contained in student answer (student may have extra text)
    if expected_clean in student_clean:
        return True

    return False


def _is_direct_request(text: str) -> bool:
    """Detect if student wants the answer immediately."""
    triggers = [
        "just tell me", "give me the answer", "what's the answer",
        "show me the answer", "skip", "i give up", "just show me",
        "tell me the answer",
    ]
    return any(t in text for t in triggers)


def _is_hint_request(text: str) -> bool:
    """Detect if student wants a hint."""
    triggers = ["hint", "help me", "i'm stuck", "im stuck", "give me a clue", "i don't know"]
    return any(t in text for t in triggers)
