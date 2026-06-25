"""Test bank: Parser module — 60+ test cases for format coverage."""
import pytest
from parser import parse_math_input


# ═══════════════════════════════════════════════════════════════════════════════
# Bracket notation [[a,b],[c,d]] — most common explicit format
# ═══════════════════════════════════════════════════════════════════════════════

class TestBracketNotation:
    def test_2x2_basic(self):
        r = parse_math_input("eigenvalues of [[2,1],[1,2]]")
        assert r.success
        assert r.object_type == "matrix"
        assert r.matrix_values == [["2", "1"], ["1", "2"]]
        assert r.operation == "eigenvalues"

    def test_3x3(self):
        r = parse_math_input("[[1,2,3],[4,5,6],[7,8,9]]")
        assert r.success
        assert r.object_type == "matrix"
        assert len(r.matrix_values) == 3
        assert len(r.matrix_values[0]) == 3

    def test_with_spaces(self):
        r = parse_math_input("[[ 2, 1 ], [ 1, 2 ]]")
        assert r.success
        assert r.matrix_values == [["2", "1"], ["1", "2"]]

    def test_negative_entries(self):
        r = parse_math_input("[[-1,2],[3,-4]]")
        assert r.success
        assert r.matrix_values == [["-1", "2"], ["3", "-4"]]

    def test_decimal_entries(self):
        r = parse_math_input("[[1.5,2.7],[3.1,4.0]]")
        assert r.success
        assert r.matrix_values == [["1.5", "2.7"], ["3.1", "4.0"]]

    def test_4x4(self):
        r = parse_math_input("det [[1,0,0,0],[0,2,0,0],[0,0,3,0],[0,0,0,4]]")
        assert r.success
        assert len(r.matrix_values) == 4
        assert r.operation == "determinant"

    def test_1x1(self):
        r = parse_math_input("[[5]]")
        assert r.success
        assert r.matrix_values == [["5"]]

    def test_symbolic_entries(self):
        r = parse_math_input("eigenvalues of [[a,1],[1,a]]")
        assert r.success
        assert r.matrix_values == [["a", "1"], ["1", "a"]]

    def test_with_preamble_text(self):
        r = parse_math_input("find the eigenvalues of the matrix [[2,1],[1,2]] please")
        assert r.success
        assert r.matrix_values == [["2", "1"], ["1", "2"]]


# ═══════════════════════════════════════════════════════════════════════════════
# Semicolon notation [a b; c d]
# ═══════════════════════════════════════════════════════════════════════════════

class TestSemicolonNotation:
    def test_basic(self):
        r = parse_math_input("[2 1; 1 2]")
        assert r.success
        assert r.object_type == "matrix"
        assert r.matrix_values == [["2", "1"], ["1", "2"]]

    def test_comma_separated(self):
        r = parse_math_input("[2,1; 1,2]")
        assert r.success
        assert r.matrix_values == [["2", "1"], ["1", "2"]]

    def test_3x3(self):
        r = parse_math_input("[1 2 3; 4 5 6; 7 8 9]")
        assert r.success
        assert len(r.matrix_values) == 3
        assert r.matrix_values[1] == ["4", "5", "6"]

    def test_with_operation(self):
        r = parse_math_input("compute eigenvalues for matrix [2 1; 1 2]")
        assert r.success
        assert r.operation == "eigenvalues"

    def test_negative_entries(self):
        r = parse_math_input("[-1 2; 3 -4]")
        assert r.success
        assert r.matrix_values == [["-1", "2"], ["3", "-4"]]


# ═══════════════════════════════════════════════════════════════════════════════
# Parenthesis notation (a,b; c,d)
# ═══════════════════════════════════════════════════════════════════════════════

class TestParenNotation:
    def test_basic(self):
        r = parse_math_input("(2,1; 1,2)")
        assert r.success
        assert r.matrix_values == [["2", "1"], ["1", "2"]]

    def test_spaces(self):
        r = parse_math_input("( 2, 1 ; 1, 2 )")
        assert r.success
        assert r.matrix_values == [["2", "1"], ["1", "2"]]

    def test_3x3(self):
        r = parse_math_input("(1,0,0; 0,1,0; 0,0,1)")
        assert r.success
        assert len(r.matrix_values) == 3


# ═══════════════════════════════════════════════════════════════════════════════
# LaTeX notation
# ═══════════════════════════════════════════════════════════════════════════════

class TestLatexNotation:
    def test_bmatrix(self):
        r = parse_math_input(r"\begin{bmatrix}2 & 1 \\ 1 & 2\end{bmatrix}")
        assert r.success
        assert r.matrix_values == [["2", "1"], ["1", "2"]]

    def test_pmatrix(self):
        r = parse_math_input(r"\begin{pmatrix}3 & 0 \\ 0 & 4\end{pmatrix}")
        assert r.success
        assert r.matrix_values == [["3", "0"], ["0", "4"]]

    def test_3x3_latex(self):
        r = parse_math_input(r"A = \begin{bmatrix}1 & 2 & 0 \\ 2 & 3 & 1 \\ 0 & 1 & 4\end{bmatrix}, find eigenvalues")
        assert r.success
        assert len(r.matrix_values) == 3
        assert r.operation == "eigenvalues"


# ═══════════════════════════════════════════════════════════════════════════════
# Operation detection
# ═══════════════════════════════════════════════════════════════════════════════

class TestOperationDetection:
    def test_eigenvalues(self):
        r = parse_math_input("find eigenvalues of [[2,1],[1,2]]")
        assert r.operation == "eigenvalues"

    def test_eigenvectors(self):
        r = parse_math_input("compute eigenvectors for [[2,1],[1,2]]")
        assert r.operation == "eigenvalues"  # eigenvectors handled by eigenvalues op

    def test_determinant(self):
        r = parse_math_input("determinant of [[3,0],[0,4]]")
        assert r.operation == "determinant"

    def test_det_abbrev(self):
        r = parse_math_input("det [[3,0],[0,4]]")
        assert r.operation == "determinant"

    def test_inverse(self):
        r = parse_math_input("inverse of [[2,1],[1,2]]")
        assert r.operation == "inverse"

    def test_rref(self):
        r = parse_math_input("rref of [[1,2,3],[4,5,6]]")
        assert r.operation == "rref"

    def test_row_reduce(self):
        r = parse_math_input("row reduce [[1,2],[3,4]]")
        assert r.operation == "rref"

    def test_derivative(self):
        r = parse_math_input("derivative of x**2 + 3*x")
        assert r.operation == "derivative"

    def test_integrate(self):
        r = parse_math_input("integrate x**2")
        assert r.operation == "integral"

    def test_solve(self):
        r = parse_math_input("solve x**2 - 4")
        assert r.operation == "solve"

    def test_no_operation(self):
        r = parse_math_input("[[2,1],[1,2]]")
        assert r.success
        assert r.operation == "eigenvalues"  # defaults for matrix


# ═══════════════════════════════════════════════════════════════════════════════
# Ambiguity detection (bare numbers)
# ═══════════════════════════════════════════════════════════════════════════════

class TestAmbiguityDetection:
    def test_bare_4_numbers(self):
        r = parse_math_input("eigenvalues of matrix 2 1 1 2")
        assert r.success
        assert r.object_type == "ambiguous"
        assert len(r.ambiguous_interpretations) >= 2

    def test_bare_9_numbers(self):
        r = parse_math_input("matrix 1 2 3 4 5 6 7 8 9")
        assert r.success
        assert r.object_type == "ambiguous"

    def test_explicit_notation_not_ambiguous(self):
        r = parse_math_input("[[2,1],[1,2]]")
        assert r.object_type == "matrix"  # not ambiguous


# ═══════════════════════════════════════════════════════════════════════════════
# Failure cases (should return success=False)
# ═══════════════════════════════════════════════════════════════════════════════

class TestParseFailures:
    def test_no_math_content(self):
        r = parse_math_input("what are eigenvalues?")
        assert not r.success  # conceptual, no explicit math

    def test_empty_input(self):
        r = parse_math_input("")
        assert not r.success

    def test_only_operation_no_object(self):
        r = parse_math_input("find the eigenvalues")
        assert not r.success
        assert r.operation == "eigenvalues"
        assert "couldn't find" in r.error_message.lower()

    def test_random_text(self):
        r = parse_math_input("hello how are you today")
        assert not r.success
