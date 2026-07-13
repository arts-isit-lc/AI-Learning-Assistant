"""Rewrite Rules — validates student intermediate steps.

Defines a fixed set of legal algebraic transformations. Used to check
whether a student's intermediate expression is a valid transformation
of the previous step, even if it doesn't exactly match the canonical
expected output.

Two validation modes:
- Final answer: SymPy.simplify(student - expected) == 0
- Intermediate step: is_valid_rewrite(previous, student_step)
"""

from __future__ import annotations

import sympy
from sympy import simplify, expand, factor, cancel, trigsimp
from sympy.parsing.sympy_parser import parse_expr


NUMERIC_TOLERANCE = 1e-8


def validate_final_answer(student_answer_str: str, expected_str: str) -> tuple[bool, str]:
    """Validate a student's final answer against the verified result.

    Uses algebraic equivalence: simplify(student - expected) == 0.

    Args:
        student_answer_str: Student's claimed answer as string.
        expected_str: Verified SymPy result as string.

    Returns:
        (is_correct, feedback_message)
    """
    try:
        student = parse_expr(student_answer_str)
        expected = parse_expr(expected_str)

        diff = simplify(student - expected)

        if diff == 0:
            return True, "Correct!"

        # Try numeric comparison for floating point
        try:
            numeric_diff = abs(complex(diff.evalf()))
            if numeric_diff < NUMERIC_TOLERANCE:
                return True, "Correct!"
        except (TypeError, ValueError):
            pass

        return False, f"Not quite. Your answer simplifies to {simplify(student)}, but the expected result is {expected}."

    except Exception as e:
        return False, f"Could not parse your answer. Please format it clearly. (Error: {e})"


def validate_step(previous_output_str: str, student_step_str: str, expected_output_str: str) -> tuple[bool, str]:
    """Validate a student's intermediate step.

    Accepts if:
    1. Student step matches expected output (via simplify), OR
    2. Student step is a valid algebraic rewrite of the previous step

    Args:
        previous_output_str: The expression from the previous step.
        student_step_str: What the student wrote for this step.
        expected_output_str: The canonical expected output for this step.

    Returns:
        (is_valid, feedback_message)
    """
    # Fast path: whitespace-normalized exact match. This accepts the canonical
    # answer directly and, crucially, handles step outputs that SymPy cannot
    # parse as scalar expressions — matrices like "[[2-lambda, 1], [1, 2-lambda]]"
    # (invalid Python: `lambda` is a keyword) and comma-separated eigenvalue
    # lists like "3, 1" (which parse to a tuple, not an Expr).
    if _normalize_ws(student_step_str) == _normalize_ws(expected_output_str):
        return True, "Correct!"

    try:
        student = parse_expr(student_step_str)
        expected = parse_expr(expected_output_str)

        # Structured outputs (matrices, vectors, comma-separated tuples) can't
        # be compared with scalar subtraction. The fast path above already
        # accepts exact matches; compare any others element-wise.
        if _is_structured(student) or _is_structured(expected):
            if _structured_equal(student, expected):
                return True, "Correct!"
            return False, f"Not quite. The expected result for this step is: {expected_output_str}"

        # Check 1: Does it match the expected output?
        if simplify(student - expected) == 0:
            return True, "Correct!"

        # Check 2: Is it a valid algebraic rewrite of the previous state?
        if previous_output_str:
            previous = parse_expr(previous_output_str)
            if not _is_structured(previous) and _is_valid_rewrite(previous, student):
                return True, "Valid transformation! (Different form but algebraically equivalent.)"

        # Check 3: Is it equivalent to expected under different simplifications?
        if _check_equivalence_forms(student, expected):
            return True, "Correct! (Written in a different but equivalent form.)"

        return False, _generate_step_feedback(student, expected)

    except Exception as e:
        return False, f"Could not parse your step. Please check the format. (Error: {e})"


def _normalize_ws(text: str) -> str:
    """Collapse all whitespace so equivalent formatting compares equal."""
    return "".join(str(text).split())


def _is_structured(obj) -> bool:
    """True for non-scalar parse results (matrices, vectors, tuples/lists)."""
    return isinstance(obj, (list, tuple, sympy.MatrixBase))


def _structured_equal(a, b) -> bool:
    """Element-wise algebraic equality for structured results.

    Lists/tuples are coerced to a SymPy Matrix so nested matrices and
    comma-separated tuples can be compared uniformly. Returns False (rather
    than raising) for shape mismatches or uncoercible inputs.
    """
    try:
        ma = a if isinstance(a, sympy.MatrixBase) else sympy.Matrix(a)
        mb = b if isinstance(b, sympy.MatrixBase) else sympy.Matrix(b)
    except Exception:
        return False
    if ma.shape != mb.shape:
        return False
    return all(simplify(x - y) == 0 for x, y in zip(ma, mb))


def _is_valid_rewrite(source: sympy.Expr, target: sympy.Expr) -> bool:
    """Check if target is a valid algebraic rewrite of source.

    Legal rewrites include:
    - Expansion: (a+b)^2 → a^2 + 2ab + b^2
    - Factoring: x^2 - 1 → (x-1)(x+1)
    - Distribution: a(b+c) → ab + ac
    - Simplification: 2x/2 → x
    - Rearrangement: a + b → b + a
    - Regrouping: (a + b) + c → a + (b + c)
    """
    # Algebraic equivalence is the core test
    diff = simplify(source - target)
    if diff == 0:
        return True

    # Try expand both and compare
    if simplify(expand(source) - expand(target)) == 0:
        return True

    # Try factor both and compare
    try:
        if simplify(factor(source) - factor(target)) == 0:
            return True
    except Exception:
        pass

    return False


def _check_equivalence_forms(student: sympy.Expr, expected: sympy.Expr) -> bool:
    """Check equivalence under various canonical forms."""
    forms_to_try = [
        (expand, expand),
        (factor, factor),
        (cancel, cancel),
        (trigsimp, trigsimp),
    ]

    for student_transform, expected_transform in forms_to_try:
        try:
            s = student_transform(student)
            e = expected_transform(expected)
            if simplify(s - e) == 0:
                return True
        except Exception:
            continue

    # Numeric comparison fallback
    try:
        s_val = complex(student.evalf())
        e_val = complex(expected.evalf())
        if abs(s_val - e_val) < NUMERIC_TOLERANCE:
            return True
    except (TypeError, ValueError):
        pass

    return False


def _generate_step_feedback(student: sympy.Expr, expected: sympy.Expr) -> str:
    """Generate targeted feedback for an incorrect step."""
    # Check if it's a sign error
    if simplify(student + expected) == 0:
        return "Check your signs — your answer has the opposite sign of what's expected."

    # Check if terms are missing
    diff = simplify(expected - student)
    if diff.is_number:
        return f"You're close, but off by a constant: {diff}"

    return f"Not quite. Check your work — the expected result for this step is: {expected}"
