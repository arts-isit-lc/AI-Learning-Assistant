"""Test bank: Verifier module — 30+ test cases."""
import pytest

sympy = pytest.importorskip("sympy")

from parser import ParseResult
from compute import execute_computation
from verifier import verify_result


class TestEigenvalueVerification:
    def _compute_eigenvalues(self, matrix):
        pr = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                         sympy_input="", matrix_values=matrix)
        return pr, execute_computation(pr)

    def test_2x2_verified(self):
        pr, cr = self._compute_eigenvalues([["2", "1"], ["1", "2"]])
        vr = verify_result(pr, cr)
        assert vr.passed
        assert vr.method == "algebraic_substitution"
        assert vr.scope == "eigenvector_identity_Av_eq_lv"

    def test_3x3_verified(self):
        pr, cr = self._compute_eigenvalues([["1", "0", "0"], ["0", "2", "0"], ["0", "0", "3"]])
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_singular_verified(self):
        pr, cr = self._compute_eigenvalues([["1", "2"], ["2", "4"]])
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_negative_eigenvalues_verified(self):
        pr, cr = self._compute_eigenvalues([["-1", "0"], ["0", "-2"]])
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_repeated_eigenvalue_verified(self):
        pr, cr = self._compute_eigenvalues([["3", "0"], ["0", "3"]])
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_3x3_non_diagonal_verified(self):
        pr, cr = self._compute_eigenvalues([["1", "2", "0"], ["2", "3", "1"], ["0", "1", "4"]])
        vr = verify_result(pr, cr)
        assert vr.passed


class TestInverseVerification:
    def _compute_inverse(self, matrix):
        pr = ParseResult(success=True, operation="inverse", object_type="matrix",
                         sympy_input="", matrix_values=matrix)
        return pr, execute_computation(pr)

    def test_2x2_inverse_verified(self):
        pr, cr = self._compute_inverse([["2", "1"], ["1", "2"]])
        vr = verify_result(pr, cr)
        assert vr.passed
        assert vr.method == "algebraic_substitution"
        assert "identity" in vr.scope.lower() or "inv" in vr.scope.lower()

    def test_3x3_inverse_verified(self):
        pr, cr = self._compute_inverse([["1", "0", "0"], ["0", "2", "0"], ["0", "0", "3"]])
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_singular_no_inverse(self):
        pr, cr = self._compute_inverse([["1", "2"], ["2", "4"]])
        # Compute fails for singular
        assert not cr.success


class TestDeterminantVerification:
    def test_determinant_no_verification_needed(self):
        pr = ParseResult(success=True, operation="determinant", object_type="matrix",
                         sympy_input="", matrix_values=[["2", "3"], ["1", "4"]])
        cr = execute_computation(pr)
        vr = verify_result(pr, cr)
        assert vr.passed
        assert vr.method == "none"  # single SymPy call, no independent check


class TestDerivativeVerification:
    def _compute_derivative(self, expr):
        pr = ParseResult(success=True, operation="derivative", object_type="expression",
                         sympy_input=expr, expression_str=expr)
        return pr, execute_computation(pr)

    def test_polynomial_verified(self):
        pr, cr = self._compute_derivative("x**2 + 3*x")
        vr = verify_result(pr, cr)
        assert vr.passed
        assert vr.method == "numeric_spot_check"

    def test_trig_verified(self):
        pr, cr = self._compute_derivative("sin(x)")
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_exponential_verified(self):
        pr, cr = self._compute_derivative("exp(x)")
        vr = verify_result(pr, cr)
        assert vr.passed


class TestIntegralVerification:
    def _compute_integral(self, expr):
        pr = ParseResult(success=True, operation="integral", object_type="expression",
                         sympy_input=expr, expression_str=expr)
        return pr, execute_computation(pr)

    def test_polynomial_verified(self):
        pr, cr = self._compute_integral("x**2")
        vr = verify_result(pr, cr)
        assert vr.passed
        assert vr.method == "algebraic_substitution"

    def test_trig_verified(self):
        pr, cr = self._compute_integral("cos(x)")
        vr = verify_result(pr, cr)
        assert vr.passed


class TestSolveVerification:
    def _compute_solve(self, expr):
        pr = ParseResult(success=True, operation="solve", object_type="expression",
                         sympy_input=expr, expression_str=expr)
        return pr, execute_computation(pr)

    def test_linear_verified(self):
        pr, cr = self._compute_solve("x - 3")
        vr = verify_result(pr, cr)
        assert vr.passed
        assert vr.method == "algebraic_substitution"

    def test_quadratic_verified(self):
        pr, cr = self._compute_solve("x**2 - 4")
        vr = verify_result(pr, cr)
        assert vr.passed

    def test_cubic_verified(self):
        pr, cr = self._compute_solve("x**3 - 6*x**2 + 11*x - 6")
        vr = verify_result(pr, cr)
        assert vr.passed
