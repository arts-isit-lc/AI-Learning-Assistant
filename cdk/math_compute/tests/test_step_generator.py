"""Test bank: Step Generator — verifies canonical step lists for all operations."""
import pytest

sympy = pytest.importorskip("sympy")

from parser import ParseResult
from compute import execute_computation
from step_generator import generate_steps


class TestEigenvalueSteps:
    def _generate(self, matrix):
        pr = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                         sympy_input="", matrix_values=matrix)
        cr = execute_computation(pr)
        return generate_steps("eigenvalues", pr, cr)

    def test_2x2_produces_4_steps(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        assert len(steps) == 4

    def test_2x2_step_descriptions(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        assert "A - λI" in steps[0].description or "lambda" in steps[0].description.lower()
        assert "determinant" in steps[1].description.lower()
        assert "factor" in steps[2].description.lower() or "simplify" in steps[2].description.lower()
        assert "solve" in steps[3].description.lower()

    def test_2x2_final_step_has_eigenvalues(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        final = steps[-1].expected_output
        assert "3" in final and "1" in final

    def test_3x3_produces_4_steps(self):
        steps = self._generate([["1", "0", "0"], ["0", "2", "0"], ["0", "0", "3"]])
        assert len(steps) == 4

    def test_all_steps_have_hints(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        for step in steps:
            assert step.hint != ""
            assert len(step.hint) > 10

    def test_all_steps_have_expected_output(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        for step in steps:
            assert step.expected_output != ""

    def test_step_ids_are_sequential(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        for i, step in enumerate(steps):
            assert step.step_id == i + 1

    def test_symbolic_matrix(self):
        steps = self._generate([["a", "1"], ["1", "a"]])
        assert len(steps) == 4
        # Final step should reference a
        assert "a" in steps[-1].expected_output


class TestDeterminantSteps:
    def _generate(self, matrix):
        pr = ParseResult(success=True, operation="determinant", object_type="matrix",
                         sympy_input="", matrix_values=matrix)
        cr = execute_computation(pr)
        return generate_steps("determinant", pr, cr)

    def test_2x2_produces_3_steps(self):
        steps = self._generate([["3", "0"], ["0", "4"]])
        assert len(steps) == 3

    def test_2x2_final_value(self):
        steps = self._generate([["3", "0"], ["0", "4"]])
        assert "12" in steps[-1].expected_output

    def test_3x3_produces_steps(self):
        steps = self._generate([["1", "2", "3"], ["0", "1", "4"], ["5", "6", "0"]])
        assert len(steps) >= 2

    def test_2x2_mentions_formula(self):
        steps = self._generate([["2", "3"], ["1", "4"]])
        # Should mention ad - bc pattern
        assert any("ad" in s.hint.lower() or "formula" in s.hint.lower() for s in steps)


class TestInverseSteps:
    def _generate(self, matrix):
        pr = ParseResult(success=True, operation="inverse", object_type="matrix",
                         sympy_input="", matrix_values=matrix)
        cr = execute_computation(pr)
        return generate_steps("inverse", pr, cr)

    def test_2x2_produces_3_steps(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        assert len(steps) == 3

    def test_2x2_first_step_is_determinant(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        assert "determinant" in steps[0].description.lower()

    def test_2x2_has_adjugate_step(self):
        steps = self._generate([["2", "1"], ["1", "2"]])
        assert any("adjugate" in s.description.lower() or "swap" in s.description.lower() for s in steps)

    def test_3x3_produces_steps(self):
        steps = self._generate([["1", "0", "0"], ["0", "2", "0"], ["0", "0", "3"]])
        assert len(steps) >= 2


class TestDerivativeSteps:
    def _generate(self, expr):
        pr = ParseResult(success=True, operation="derivative", object_type="expression",
                         sympy_input=expr, expression_str=expr)
        cr = execute_computation(pr)
        return generate_steps("derivative", pr, cr)

    def test_power_rule(self):
        steps = self._generate("x**2")
        assert len(steps) >= 2
        assert "rule" in steps[0].description.lower()

    def test_polynomial(self):
        steps = self._generate("x**3 + 2*x**2 - x + 1")
        assert len(steps) >= 2
        assert "3*x**2" in steps[1].expected_output or "3x^2" in steps[1].expected_output.replace(" ", "")

    def test_trig(self):
        steps = self._generate("sin(x)")
        assert len(steps) >= 2
        assert "cos" in steps[1].expected_output

    def test_has_rule_identification_step(self):
        steps = self._generate("x**2")
        assert any("identify" in s.description.lower() or "rule" in s.description.lower() for s in steps)


class TestIntegralSteps:
    def _generate(self, expr):
        pr = ParseResult(success=True, operation="integral", object_type="expression",
                         sympy_input=expr, expression_str=expr)
        cr = execute_computation(pr)
        return generate_steps("integral", pr, cr)

    def test_power_rule(self):
        steps = self._generate("x**2")
        assert len(steps) >= 2

    def test_has_constant_step(self):
        steps = self._generate("x**2")
        assert any("constant" in s.description.lower() or "+ C" in s.expected_output for s in steps)

    def test_result_contains_integral(self):
        steps = self._generate("x**2")
        # Should have x**3/3 somewhere in steps
        assert any("x**3" in s.expected_output for s in steps)


class TestSolveSteps:
    def _generate(self, expr):
        pr = ParseResult(success=True, operation="solve", object_type="expression",
                         sympy_input=expr, expression_str=expr)
        cr = execute_computation(pr)
        return generate_steps("solve", pr, cr)

    def test_linear(self):
        steps = self._generate("x - 3")
        assert len(steps) >= 2
        assert "3" in steps[-1].expected_output

    def test_quadratic_has_factor_step(self):
        steps = self._generate("x**2 - 4")
        assert len(steps) >= 2
        assert any("factor" in s.description.lower() or "quadratic" in s.hint.lower() for s in steps)

    def test_quadratic_final_has_solutions(self):
        steps = self._generate("x**2 - 4")
        final = steps[-1].expected_output
        assert "2" in final and "-2" in final
