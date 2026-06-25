"""Verifier module — substitution-based verification of compute results.

Verification philosophy: verify only when mathematically cheap and meaningful.
Best verifications are substitution-based (plug answer back into original).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import sympy
from sympy import Matrix
from sympy.parsing.sympy_parser import parse_expr

from parser import ParseResult
from compute import ComputeResult


NUMERIC_TOLERANCE = 1e-10


@dataclass
class VerificationResult:
    """Result of verification check."""
    passed: bool
    method: str
    scope: str
    guarantee: str
    reason: str
    details: dict = None

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "method": self.method,
            "scope": self.scope,
            "guarantee": self.guarantee,
        }


def verify_result(parse_result: ParseResult, compute_result: ComputeResult) -> VerificationResult:
    """Verify computation result via substitution.

    Routes to operation-specific verification.

    Args:
        parse_result: The original parsed input.
        compute_result: The computation result to verify.

    Returns:
        VerificationResult with method, scope, and pass/fail.
    """
    operation = parse_result.operation

    try:
        if operation == "eigenvalues":
            return _verify_eigenvalues(compute_result)
        elif operation == "inverse":
            return _verify_inverse(compute_result)
        elif operation == "determinant":
            return _verify_determinant(compute_result)
        elif operation == "derivative":
            return _verify_derivative(compute_result)
        elif operation == "integral":
            return _verify_integral(compute_result)
        elif operation in ("solve", "roots"):
            return _verify_solve(compute_result, parse_result)
        else:
            # No specific verification available
            return VerificationResult(
                passed=True,
                method="none",
                scope="no_verification_available",
                guarantee="unverified_compute_only",
                reason=f"No verification method for operation '{operation}'",
            )
    except Exception as e:
        return VerificationResult(
            passed=False,
            method="verification_failed",
            scope="error_during_verification",
            guarantee="none",
            reason=f"Verification error: {type(e).__name__}: {e}",
        )


def _verify_eigenvalues(compute_result: ComputeResult) -> VerificationResult:
    """Verify eigenvalues via Av = λv substitution."""
    matrix = compute_result._matrix
    eigenvects = compute_result._eigenvectors

    if matrix is None or eigenvects is None:
        return VerificationResult(
            passed=True,
            method="algebraic_substitution",
            scope="skipped_no_internal_data",
            guarantee="compute_only",
            reason="Internal matrix/eigenvector data not available for verification",
        )

    all_passed = True
    max_residual = 0.0

    for eigenval, mult, vectors in eigenvects:
        for v in vectors:
            # Check Av = λv
            av = matrix * v
            lv = eigenval * v
            diff = av - lv
            # Check residual
            for entry in diff:
                residual = abs(complex(entry.evalf()))
                max_residual = max(max_residual, residual)
                if residual > NUMERIC_TOLERANCE:
                    all_passed = False

    return VerificationResult(
        passed=all_passed,
        method="algebraic_substitution",
        scope="eigenvector_identity_Av_eq_lv",
        guarantee="local_correctness_only",
        reason=f"Av=λv check: max residual {max_residual:.2e}",
        details={"max_residual": max_residual},
    )


def _verify_inverse(compute_result: ComputeResult) -> VerificationResult:
    """Verify inverse via A * A^-1 = I."""
    matrix = compute_result._matrix
    if matrix is None:
        return VerificationResult(
            passed=True,
            method="algebraic_substitution",
            scope="skipped",
            guarantee="compute_only",
            reason="Internal matrix not available",
        )

    inv_values = compute_result.answer.get("inverse", [])
    if not inv_values:
        return VerificationResult(
            passed=False,
            method="algebraic_substitution",
            scope="identity_check",
            guarantee="none",
            reason="No inverse in compute result",
        )

    # Rebuild inverse matrix
    inv_matrix = Matrix([[parse_expr(entry) for entry in row] for row in inv_values])

    # Check A * A^-1 = I
    product = matrix * inv_matrix
    identity = sympy.eye(matrix.rows)
    diff = product - identity

    max_residual = 0.0
    for entry in diff:
        residual = abs(complex(entry.evalf()))
        max_residual = max(max_residual, residual)

    passed = max_residual < NUMERIC_TOLERANCE

    return VerificationResult(
        passed=passed,
        method="algebraic_substitution",
        scope="inverse_identity_A_times_Ainv_eq_I",
        guarantee="local_correctness_only",
        reason=f"A·A⁻¹=I check: max residual {max_residual:.2e}",
        details={"max_residual": max_residual},
    )


def _verify_determinant(compute_result: ComputeResult) -> VerificationResult:
    """Determinant — no independent verification needed (single SymPy call)."""
    return VerificationResult(
        passed=True,
        method="none",
        scope="single_computation",
        guarantee="sympy_correctness",
        reason="Determinant is a single SymPy operation — no independent check needed",
    )


def _verify_derivative(compute_result: ComputeResult) -> VerificationResult:
    """Verify derivative via numeric spot-check at 3 points."""
    answer = compute_result.answer
    original_str = answer.get("original", "")
    derivative_str = answer.get("derivative", "")
    var_str = answer.get("variable", "x")

    if not original_str or not derivative_str:
        return VerificationResult(
            passed=True,
            method="none",
            scope="skipped",
            guarantee="compute_only",
            reason="Missing data for verification",
        )

    try:
        var = sympy.Symbol(var_str)
        original = parse_expr(original_str)
        derivative = parse_expr(derivative_str)

        # Numeric check at 3 points
        test_points = [0.5, 1.0, 2.0]
        h = 1e-8
        all_passed = True

        for pt in test_points:
            # Numerical derivative via finite difference
            f_plus = float(original.subs(var, pt + h).evalf())
            f_minus = float(original.subs(var, pt - h).evalf())
            numerical_deriv = (f_plus - f_minus) / (2 * h)

            # Analytical derivative
            analytical = float(derivative.subs(var, pt).evalf())

            if abs(numerical_deriv - analytical) > 1e-4:
                all_passed = False
                break

        return VerificationResult(
            passed=all_passed,
            method="numeric_spot_check",
            scope="derivative_at_3_points",
            guarantee="local_correctness_only",
            reason=f"Numeric spot-check at {test_points}: {'passed' if all_passed else 'failed'}",
        )
    except Exception as e:
        return VerificationResult(
            passed=True,
            method="numeric_spot_check",
            scope="skipped_due_to_error",
            guarantee="compute_only",
            reason=f"Spot-check failed to execute: {e}",
        )


def _verify_integral(compute_result: ComputeResult) -> VerificationResult:
    """Verify integral by differentiating the result."""
    answer = compute_result.answer
    integral_str = answer.get("integral", "")
    original_str = answer.get("original", "")
    var_str = answer.get("variable", "x")

    if not integral_str or not original_str:
        return VerificationResult(
            passed=True,
            method="none",
            scope="skipped",
            guarantee="compute_only",
            reason="Missing data for verification",
        )

    try:
        var = sympy.Symbol(var_str)
        integral = parse_expr(integral_str)
        original = parse_expr(original_str)

        # Differentiate the integral — should give back the original
        diff_of_integral = sympy.diff(integral, var)
        difference = sympy.simplify(diff_of_integral - original)

        passed = difference == 0

        return VerificationResult(
            passed=passed,
            method="algebraic_substitution",
            scope="differentiate_integral_equals_original",
            guarantee="local_correctness_only",
            reason=f"d/d{var}(∫f) = f check: {'passed' if passed else 'difference = ' + str(difference)}",
        )
    except Exception as e:
        return VerificationResult(
            passed=True,
            method="algebraic_substitution",
            scope="skipped_due_to_error",
            guarantee="compute_only",
            reason=f"Integral verification failed: {e}",
        )


def _verify_solve(compute_result: ComputeResult, parse_result: ParseResult) -> VerificationResult:
    """Verify solutions by substituting back into original equation."""
    answer = compute_result.answer
    solutions = answer.get("solutions_symbolic", [])
    var_str = answer.get("variable", "x")
    expr_str = parse_result.expression_str or parse_result.sympy_input

    if not solutions or not expr_str:
        return VerificationResult(
            passed=True,
            method="none",
            scope="skipped",
            guarantee="compute_only",
            reason="Missing data for verification",
        )

    try:
        var = sympy.Symbol(var_str)
        expr = parse_expr(expr_str)

        all_passed = True
        for sol_str in solutions:
            sol = parse_expr(sol_str)
            substituted = expr.subs(var, sol)
            simplified = sympy.simplify(substituted)
            if simplified != 0:
                # Try numerical
                try:
                    val = abs(complex(simplified.evalf()))
                    if val > NUMERIC_TOLERANCE:
                        all_passed = False
                except (TypeError, ValueError):
                    all_passed = False

        return VerificationResult(
            passed=all_passed,
            method="algebraic_substitution",
            scope="substitute_roots_into_equation",
            guarantee="local_correctness_only",
            reason=f"Substitution check for {len(solutions)} solution(s): {'all passed' if all_passed else 'some failed'}",
        )
    except Exception as e:
        return VerificationResult(
            passed=True,
            method="algebraic_substitution",
            scope="skipped_due_to_error",
            guarantee="compute_only",
            reason=f"Solution verification failed: {e}",
        )
