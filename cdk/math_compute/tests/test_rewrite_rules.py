"""Test bank: Rewrite Rules — validates step checking and final answer equivalence."""
import pytest

sympy = pytest.importorskip("sympy")

from rewrite_rules import validate_final_answer, validate_step


class TestFinalAnswerValidation:
    def test_exact_match(self):
        ok, msg = validate_final_answer("3", "3")
        assert ok

    def test_equivalent_expressions(self):
        ok, msg = validate_final_answer("(x-1)*(x-3)", "x**2 - 4*x + 3")
        assert ok

    def test_factored_vs_expanded(self):
        ok, msg = validate_final_answer("x**2 - 4*x + 3", "(x-1)*(x-3)")
        assert ok

    def test_wrong_answer(self):
        ok, msg = validate_final_answer("5", "3")
        assert not ok

    def test_close_but_wrong(self):
        ok, msg = validate_final_answer("4", "3")
        assert not ok

    def test_symbolic_equivalence(self):
        ok, msg = validate_final_answer("2*x + 2", "2*(x + 1)")
        assert ok

    def test_negative_sign_error(self):
        ok, msg = validate_final_answer("-3", "3")
        assert not ok

    def test_fraction_equivalence(self):
        ok, msg = validate_final_answer("1/3", "1/3")
        assert ok

    def test_decimal_vs_fraction(self):
        # 0.333... ≈ 1/3 — should handle within tolerance
        ok, msg = validate_final_answer("0.333333333", "1/3")
        assert ok

    def test_parse_error_handled(self):
        ok, msg = validate_final_answer("???invalid", "3")
        assert not ok
        assert "parse" in msg.lower() or "format" in msg.lower()


class TestStepValidation:
    def test_exact_match(self):
        ok, msg = validate_step("x**2 - 4", "(x-2)*(x+2)", "(x-2)*(x+2)")
        assert ok

    def test_equivalent_to_expected(self):
        ok, msg = validate_step("", "x**2 - 4*x + 3", "x**2 - 4*x + 3")
        assert ok

    def test_valid_rewrite_of_previous(self):
        # Factoring is a valid rewrite
        ok, msg = validate_step("x**2 - 4", "(x-2)*(x+2)", "x**2 - 4")
        # Student wrote the expanded form which equals previous — valid
        assert ok

    def test_expansion_is_valid(self):
        # Expanding (a+b)^2 is valid
        ok, msg = validate_step("(x+1)**2", "x**2 + 2*x + 1", "x**2 + 2*x + 1")
        assert ok

    def test_rearrangement_valid(self):
        ok, msg = validate_step("", "1 + 2*x + x**2", "x**2 + 2*x + 1")
        assert ok

    def test_wrong_step(self):
        ok, msg = validate_step("x**2 - 4", "x + 5", "(x-2)*(x+2)")
        assert not ok

    def test_sign_error_detected(self):
        # Student has opposite sign
        ok, msg = validate_step("", "-(x-3)", "x-3")
        assert not ok
        assert "sign" in msg.lower() or "not quite" in msg.lower()

    def test_off_by_constant(self):
        ok, msg = validate_step("", "x**2 + 1", "x**2")
        assert not ok

    def test_parse_error_handled(self):
        ok, msg = validate_step("", "!!invalid!!", "x**2")
        assert not ok
        assert "parse" in msg.lower() or "format" in msg.lower()


class TestRewriteEquivalence:
    """Test that various algebraic rewrites are recognized as valid."""

    def test_distribute(self):
        ok, _ = validate_step("2*(x+1)", "2*x + 2", "2*x + 2")
        assert ok

    def test_combine_fractions(self):
        ok, _ = validate_step("", "x/2 + x/2", "x")
        assert ok

    def test_simplify_fraction(self):
        ok, _ = validate_step("", "2*x/2", "x")
        assert ok

    def test_commutative(self):
        ok, _ = validate_step("", "b + a", "a + b")
        assert ok

    def test_nested_simplification(self):
        ok, _ = validate_step("", "((x+1)-1)", "x")
        assert ok
