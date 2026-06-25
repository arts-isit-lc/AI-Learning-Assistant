"""Test bank: Tutor Runtime — state machine transitions."""
import pytest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

sympy = pytest.importorskip("sympy")

from tutor_runtime import (
    TutorState, TutorAction, initialize_tutor, process_student_input,
    get_initial_prompt,
)
from step_generator import SolutionStep


def _make_steps():
    """Create sample steps for testing."""
    return [
        SolutionStep(step_id=1, description="Form A - λI",
                     expected_output="[[2-lambda, 1], [1, 2-lambda]]",
                     transformation_type="matrix_subtraction",
                     hint="Subtract lambda from diagonal"),
        SolutionStep(step_id=2, description="Compute determinant",
                     expected_output="lambda**2 - 4*lambda + 3",
                     transformation_type="determinant_expansion",
                     hint="Use ad - bc formula"),
        SolutionStep(step_id=3, description="Solve",
                     expected_output="3, 1",
                     transformation_type="solve_equation",
                     hint="Factor the quadratic"),
    ]


class TestInitialization:
    def test_initialize_creates_active_state(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        assert state.active
        assert state.current_step_index == 0
        assert state.stuck_count == 0
        assert state.mode == "socratic"
        assert len(state.step_list) == 3

    def test_initial_prompt_presents_first_step(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        action = get_initial_prompt(state)
        assert action.action_type == "present_step"
        assert "step" in action.message.lower() or "Form" in action.message


class TestSocraticProgression:
    def test_correct_answer_advances(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "[[2-lambda, 1], [1, 2-lambda]]")
        assert state.current_step_index == 1
        assert action.action_type == "confirm_advance"

    def test_incorrect_answer_gives_hint(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "totally wrong answer")
        assert state.current_step_index == 0  # did NOT advance
        assert state.stuck_count == 1
        assert action.action_type == "give_hint"

    def test_stuck_reveals_after_threshold(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        # Fail twice
        state, _ = process_student_input(state, "wrong")
        state, action = process_student_input(state, "still wrong")
        assert state.current_step_index == 1  # advanced past step 1
        assert state.stuck_count == 0  # reset
        assert action.action_type == "reveal_step"

    def test_completing_all_steps(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        # Answer all correctly
        state, _ = process_student_input(state, "[[2-lambda, 1], [1, 2-lambda]]")
        state, _ = process_student_input(state, "lambda**2 - 4*lambda + 3")
        state, action = process_student_input(state, "3, 1")
        assert state.completed
        assert action.action_type in ("confirm_advance", "present_answer")
        assert action.is_complete


class TestDirectMode:
    def test_just_tell_me(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "just tell me the answer")
        assert state.mode == "direct"
        assert state.completed
        assert action.action_type == "present_answer"
        assert action.final_answer == {"eigenvalues": [3, 1]}

    def test_give_up(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "i give up")
        assert state.completed
        assert action.action_type == "present_answer"

    def test_skip(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "skip")
        assert state.completed


class TestHintMode:
    def test_hint_request(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "give me a hint")
        assert action.action_type == "give_hint"
        assert "hint" in action.message.lower() or "Hint" in action.message

    def test_im_stuck(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "I'm stuck")
        assert action.action_type == "give_hint"

    def test_hint_does_not_advance(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state, action = process_student_input(state, "hint please")
        assert state.current_step_index == 0  # still on step 1


class TestStateSerialization:
    def test_to_dict_and_back(self):
        steps = _make_steps()
        state = initialize_tutor(steps, {"eigenvalues": [3, 1]}, "eigenvalues")
        state.current_step_index = 2
        state.stuck_count = 1

        d = state.to_dict()
        restored = TutorState.from_dict(d)

        assert restored.current_step_index == 2
        assert restored.stuck_count == 1
        assert restored.active
        assert len(restored.step_list) == 3

    def test_empty_state(self):
        state = TutorState()
        d = state.to_dict()
        restored = TutorState.from_dict(d)
        assert not restored.active
