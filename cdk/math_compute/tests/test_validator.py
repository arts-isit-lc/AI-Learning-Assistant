"""Test bank: Validator module — 25+ test cases."""
import pytest
from parser import ParseResult
from validator import validate_input, MAX_MATRIX_SIZE


class TestMatrixValidation:
    def test_valid_2x2(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                        matrix_values=[["2", "1"], ["1", "2"]])
        v = validate_input(r)
        assert v.valid

    def test_valid_3x3(self):
        r = ParseResult(success=True, operation="determinant", object_type="matrix",
                        matrix_values=[["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]])
        v = validate_input(r)
        assert v.valid

    def test_too_large_matrix(self):
        big = [["1"] * 11 for _ in range(11)]
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix", matrix_values=big)
        v = validate_input(r)
        assert not v.valid
        assert "exceeds" in v.error_message.lower()

    def test_max_size_exactly(self):
        matrix = [["1"] * MAX_MATRIX_SIZE for _ in range(MAX_MATRIX_SIZE)]
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix", matrix_values=matrix)
        v = validate_input(r)
        assert v.valid

    def test_non_square_for_eigenvalues(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                        matrix_values=[["1", "2", "3"], ["4", "5", "6"]])
        v = validate_input(r)
        assert not v.valid
        assert "square" in v.error_message.lower()

    def test_non_square_for_determinant(self):
        r = ParseResult(success=True, operation="determinant", object_type="matrix",
                        matrix_values=[["1", "2"], ["3", "4"], ["5", "6"]])
        v = validate_input(r)
        assert not v.valid

    def test_non_square_for_rref_allowed(self):
        r = ParseResult(success=True, operation="rref", object_type="matrix",
                        matrix_values=[["1", "2", "3"], ["4", "5", "6"]])
        v = validate_input(r)
        assert v.valid  # RREF doesn't require square

    def test_invalid_entry(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                        matrix_values=[["2", "hello!!"], ["1", "2"]])
        v = validate_input(r)
        assert not v.valid
        assert "parse" in v.error_message.lower() or "entry" in v.error_message.lower()

    def test_symbolic_entries_allowed(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                        matrix_values=[["a", "1"], ["1", "a"]])
        v = validate_input(r)
        assert v.valid

    def test_expression_entries_allowed(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                        matrix_values=[["2*x", "1"], ["1", "x+1"]])
        v = validate_input(r)
        assert v.valid

    def test_empty_matrix(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix", matrix_values=[])
        v = validate_input(r)
        assert not v.valid

    def test_negative_entries(self):
        r = ParseResult(success=True, operation="eigenvalues", object_type="matrix",
                        matrix_values=[["-3", "2"], ["1", "-5"]])
        v = validate_input(r)
        assert v.valid


class TestExpressionValidation:
    def test_valid_expression(self):
        r = ParseResult(success=True, operation="derivative", object_type="expression",
                        expression_str="x**2 + 3*x - 5")
        v = validate_input(r)
        assert v.valid

    def test_empty_expression(self):
        r = ParseResult(success=True, operation="derivative", object_type="expression",
                        expression_str="")
        v = validate_input(r)
        assert not v.valid

    def test_unbalanced_parens(self):
        r = ParseResult(success=True, operation="derivative", object_type="expression",
                        expression_str="(x+1)*(x-1")
        v = validate_input(r)
        assert not v.valid
        assert "parenthes" in v.error_message.lower()

    def test_balanced_parens(self):
        r = ParseResult(success=True, operation="solve", object_type="expression",
                        expression_str="(x+1)*(x-1)")
        v = validate_input(r)
        assert v.valid
