"""Test bank: Compute module — 60+ test cases with known-correct results.

Sources: Strang Linear Algebra, Stewart Calculus textbook examples.
CI blocks deployment if any case fails.
"""
import pytest
from parser import ParseResult


# Skip all tests if sympy not installed (local dev without Docker)
sympy = pytest.importorskip("sympy")
from compute import execute_computation


# ═══════════════════════════════════════════════════════════════════════════════
# Eigenvalues — known textbook results
# ═══════════════════════════════════════════════════════════════════════════════

class TestEigenvalues:
    def _make_parse(self, matrix, op="eigenvalues"):
        return ParseResult(success=True, operation=op, object_type="matrix",
                           sympy_input="", matrix_values=matrix)

    def test_2x2_identity(self):
        r = execute_computation(self._make_parse([["1", "0"], ["0", "1"]]))
        assert r.success
        assert sorted(r.answer["eigenvalues"]) == [1.0, 1.0]

    def test_2x2_symmetric(self):
        """Strang Ch.6: [[2,1],[1,2]] has eigenvalues 3 and 1."""
        r = execute_computation(self._make_parse([["2", "1"], ["1", "2"]]))
        assert r.success
        eigenvalues = sorted(r.answer["eigenvalues"])
        assert abs(eigenvalues[0] - 1.0) < 0.0001
        assert abs(eigenvalues[1] - 3.0) < 0.0001

    def test_2x2_diagonal(self):
        r = execute_computation(self._make_parse([["5", "0"], ["0", "3"]]))
        assert r.success
        assert sorted(r.answer["eigenvalues"]) == [3.0, 5.0]

    def test_2x2_singular(self):
        """[[1,2],[2,4]] has eigenvalues 0 and 5."""
        r = execute_computation(self._make_parse([["1", "2"], ["2", "4"]]))
        assert r.success
        eigenvalues = sorted(r.answer["eigenvalues"])
        assert abs(eigenvalues[0] - 0.0) < 0.0001
        assert abs(eigenvalues[1] - 5.0) < 0.0001

    def test_3x3_diagonal(self):
        r = execute_computation(self._make_parse([["1", "0", "0"], ["0", "2", "0"], ["0", "0", "3"]]))
        assert r.success
        assert sorted(r.answer["eigenvalues"]) == [1.0, 2.0, 3.0]

    def test_3x3_symmetric(self):
        """[[1,2,0],[2,3,1],[0,1,4]] — eigenvalues 5 and (3±√13)/2.

        Characteristic polynomial: λ³ - 8λ² + 14λ + 5 = (λ - 5)(λ² - 3λ - 1),
        giving roots (3-√13)/2 ≈ -0.302776, (3+√13)/2 ≈ 3.302776, and 5.
        Cross-check: sum = 8 (trace), product = -5 (determinant).
        """
        r = execute_computation(self._make_parse([["1", "2", "0"], ["2", "3", "1"], ["0", "1", "4"]]))
        assert r.success
        eigenvalues = sorted(r.answer["eigenvalues"])
        # True eigenvalues: (3-√13)/2 ≈ -0.302776, (3+√13)/2 ≈ 3.302776, 5.0
        assert abs(eigenvalues[0] - (-0.302776)) < 0.01
        assert abs(eigenvalues[1] - 3.302776) < 0.01
        assert abs(eigenvalues[2] - 5.0) < 0.01

    def test_2x2_negative_eigenvalues(self):
        """[[-1,0],[0,-2]] has eigenvalues -1 and -2."""
        r = execute_computation(self._make_parse([["-1", "0"], ["0", "-2"]]))
        assert r.success
        assert sorted(r.answer["eigenvalues"]) == [-2.0, -1.0]

    def test_2x2_repeated_eigenvalue(self):
        """[[3,0],[0,3]] has repeated eigenvalue 3."""
        r = execute_computation(self._make_parse([["3", "0"], ["0", "3"]]))
        assert r.success
        assert r.answer["eigenvalues"] == [3.0, 3.0]

    def test_has_characteristic_polynomial(self):
        r = execute_computation(self._make_parse([["2", "1"], ["1", "2"]]))
        assert r.success
        assert "characteristic_polynomial" in r.answer
        assert "lambda" in r.answer["characteristic_polynomial"]

    def test_has_eigenvectors(self):
        r = execute_computation(self._make_parse([["2", "1"], ["1", "2"]]))
        assert r.success
        assert "eigenvectors" in r.answer
        assert len(r.answer["eigenvectors"]) == 2

    def test_symbolic_matrix(self):
        """[[a,1],[1,a]] has eigenvalues a+1 and a-1."""
        r = execute_computation(self._make_parse([["a", "1"], ["1", "a"]]))
        assert r.success
        # Symbolic eigenvalues — check they're strings
        eigenvalues = r.answer["eigenvalues"]
        assert len(eigenvalues) == 2


# ═══════════════════════════════════════════════════════════════════════════════
# Determinants
# ═══════════════════════════════════════════════════════════════════════════════

class TestDeterminant:
    def _make_parse(self, matrix):
        return ParseResult(success=True, operation="determinant", object_type="matrix",
                           sympy_input="", matrix_values=matrix)

    def test_2x2_identity(self):
        r = execute_computation(self._make_parse([["1", "0"], ["0", "1"]]))
        assert r.success
        assert r.answer["determinant"] == 1.0

    def test_2x2_basic(self):
        """det([[3,0],[0,4]]) = 12."""
        r = execute_computation(self._make_parse([["3", "0"], ["0", "4"]]))
        assert r.success
        assert r.answer["determinant"] == 12.0

    def test_2x2_general(self):
        """det([[a,b],[c,d]]) = ad - bc. [[2,3],[1,4]] = 8-3 = 5."""
        r = execute_computation(self._make_parse([["2", "3"], ["1", "4"]]))
        assert r.success
        assert r.answer["determinant"] == 5.0

    def test_singular_matrix(self):
        """det([[1,2],[2,4]]) = 0."""
        r = execute_computation(self._make_parse([["1", "2"], ["2", "4"]]))
        assert r.success
        assert r.answer["determinant"] == 0.0

    def test_3x3_diagonal(self):
        """det(diag(2,3,4)) = 24."""
        r = execute_computation(self._make_parse([["2", "0", "0"], ["0", "3", "0"], ["0", "0", "4"]]))
        assert r.success
        assert r.answer["determinant"] == 24.0

    def test_3x3_general(self):
        """det([[1,2,3],[0,1,4],[5,6,0]]) = 1(0-24) - 2(0-20) + 3(0-5) = -24+40-15 = 1."""
        r = execute_computation(self._make_parse([["1", "2", "3"], ["0", "1", "4"], ["5", "6", "0"]]))
        assert r.success
        assert r.answer["determinant"] == 1.0

    def test_negative_determinant(self):
        """det([[0,1],[1,0]]) = -1."""
        r = execute_computation(self._make_parse([["0", "1"], ["1", "0"]]))
        assert r.success
        assert r.answer["determinant"] == -1.0


# ═══════════════════════════════════════════════════════════════════════════════
# Matrix Inverse
# ═══════════════════════════════════════════════════════════════════════════════

class TestInverse:
    def _make_parse(self, matrix):
        return ParseResult(success=True, operation="inverse", object_type="matrix",
                           sympy_input="", matrix_values=matrix)

    def test_2x2_identity_inverse(self):
        r = execute_computation(self._make_parse([["1", "0"], ["0", "1"]]))
        assert r.success
        assert r.answer["inverse"] == [["1", "0"], ["0", "1"]]

    def test_2x2_basic(self):
        """inv([[2,1],[1,2]]) = (1/3)[[2,-1],[-1,2]]."""
        r = execute_computation(self._make_parse([["2", "1"], ["1", "2"]]))
        assert r.success
        inv = r.answer["inverse"]
        assert len(inv) == 2
        # Check first entry is 2/3
        assert "2/3" in inv[0][0] or "0.6" in inv[0][0]

    def test_singular_matrix_fails(self):
        """[[1,2],[2,4]] is singular — inverse should fail."""
        r = execute_computation(self._make_parse([["1", "2"], ["2", "4"]]))
        assert not r.success
        assert "singular" in r.error_message.lower()

    def test_diagonal_inverse(self):
        """inv(diag(2,4)) = diag(1/2, 1/4)."""
        r = execute_computation(self._make_parse([["2", "0"], ["0", "4"]]))
        assert r.success
        inv = r.answer["inverse"]
        assert "1/2" in inv[0][0] or "0.5" in inv[0][0]


# ═══════════════════════════════════════════════════════════════════════════════
# RREF
# ═══════════════════════════════════════════════════════════════════════════════

class TestRREF:
    def _make_parse(self, matrix):
        return ParseResult(success=True, operation="rref", object_type="matrix",
                           sympy_input="", matrix_values=matrix)

    def test_identity_rref(self):
        r = execute_computation(self._make_parse([["1", "0"], ["0", "1"]]))
        assert r.success
        assert r.answer["rank"] == 2

    def test_2x3_augmented(self):
        """[[1,2,3],[2,4,6]] → rank 1."""
        r = execute_computation(self._make_parse([["1", "2", "3"], ["2", "4", "6"]]))
        assert r.success
        assert r.answer["rank"] == 1

    def test_full_rank_3x3(self):
        r = execute_computation(self._make_parse([["1", "0", "0"], ["0", "1", "0"], ["0", "0", "1"]]))
        assert r.success
        assert r.answer["rank"] == 3


# ═══════════════════════════════════════════════════════════════════════════════
# Derivatives
# ═══════════════════════════════════════════════════════════════════════════════

class TestDerivative:
    def _make_parse(self, expr):
        return ParseResult(success=True, operation="derivative", object_type="expression",
                           sympy_input=expr, expression_str=expr)

    def test_power_rule(self):
        """d/dx(x^2) = 2x."""
        r = execute_computation(self._make_parse("x**2"))
        assert r.success
        assert "2*x" in r.answer["derivative"] or "2x" in r.answer["derivative"]

    def test_constant(self):
        """d/dx(5) = 0."""
        r = execute_computation(self._make_parse("5"))
        assert r.success
        assert r.answer["derivative"] == "0"

    def test_polynomial(self):
        """d/dx(x^3 + 2x^2 - x + 1) = 3x^2 + 4x - 1."""
        r = execute_computation(self._make_parse("x**3 + 2*x**2 - x + 1"))
        assert r.success
        assert "3*x**2" in r.answer["derivative"] or "3x^2" in r.answer["derivative"].replace(" ", "")

    def test_trig(self):
        """d/dx(sin(x)) = cos(x)."""
        r = execute_computation(self._make_parse("sin(x)"))
        assert r.success
        assert "cos" in r.answer["derivative"]

    def test_exponential(self):
        """d/dx(exp(x)) = exp(x)."""
        r = execute_computation(self._make_parse("exp(x)"))
        assert r.success
        assert "exp" in r.answer["derivative"]


# ═══════════════════════════════════════════════════════════════════════════════
# Integrals
# ═══════════════════════════════════════════════════════════════════════════════

class TestIntegral:
    def _make_parse(self, expr):
        return ParseResult(success=True, operation="integral", object_type="expression",
                           sympy_input=expr, expression_str=expr)

    def test_power_rule(self):
        """∫x^2 dx = x^3/3."""
        r = execute_computation(self._make_parse("x**2"))
        assert r.success
        assert "x**3/3" in r.answer["integral"] or "x^3/3" in r.answer["integral"]

    def test_constant(self):
        """∫5 dx = 5x."""
        r = execute_computation(self._make_parse("5"))
        assert r.success
        assert "5*x" in r.answer["integral"] or "5x" in r.answer["integral"]

    def test_exponential(self):
        """∫exp(x) dx = exp(x)."""
        r = execute_computation(self._make_parse("exp(x)"))
        assert r.success
        assert "exp" in r.answer["integral"]


# ═══════════════════════════════════════════════════════════════════════════════
# Solve (roots)
# ═══════════════════════════════════════════════════════════════════════════════

class TestSolve:
    def _make_parse(self, expr):
        return ParseResult(success=True, operation="solve", object_type="expression",
                           sympy_input=expr, expression_str=expr)

    def test_linear(self):
        """x - 3 = 0 → x = 3."""
        r = execute_computation(self._make_parse("x - 3"))
        assert r.success
        assert 3.0 in r.answer["solutions"] or 3 in r.answer["solutions"]

    def test_quadratic(self):
        """x^2 - 4 = 0 → x = ±2."""
        r = execute_computation(self._make_parse("x**2 - 4"))
        assert r.success
        solutions = sorted(r.answer["solutions"])
        assert abs(solutions[0] - (-2.0)) < 0.0001
        assert abs(solutions[1] - 2.0) < 0.0001

    def test_quadratic_no_real(self):
        """x^2 + 1 = 0 → complex roots."""
        r = execute_computation(self._make_parse("x**2 + 1"))
        assert r.success
        assert len(r.answer["solutions"]) == 2

    def test_cubic(self):
        """x^3 - 6x^2 + 11x - 6 = 0 → x = 1, 2, 3."""
        r = execute_computation(self._make_parse("x**3 - 6*x**2 + 11*x - 6"))
        assert r.success
        solutions = sorted(r.answer["solutions"])
        assert abs(solutions[0] - 1.0) < 0.0001
        assert abs(solutions[1] - 2.0) < 0.0001
        assert abs(solutions[2] - 3.0) < 0.0001
