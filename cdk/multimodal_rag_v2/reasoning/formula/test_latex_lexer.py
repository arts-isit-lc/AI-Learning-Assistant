"""Tests for LatexLexer (parser-free profiling)."""

from __future__ import annotations

from ...models.data_models import EquationType
from .latex_lexer import LatexLexer


def _profile(latex: str):
    return LatexLexer.profile("Equation X", latex)


class TestProfileExtraction:
    def test_variables_and_operators(self):
        p = _profile("x + y = z")
        assert p.variables == ["x", "y", "z"]
        assert "+" in p.operators and "=" in p.operators

    def test_functions_from_commands(self):
        p = _profile(r"\sin(x) + \log(y)")
        assert "sin" in p.functions and "log" in p.functions

    def test_greek_symbols(self):
        p = _profile(r"\alpha x + \beta")
        assert p.greek == ["alpha", "beta"]

    def test_big_operators_are_functions(self):
        p = _profile(r"\sum_{i=1}^{n} x_i")
        assert "sum" in p.functions
        assert "x" in p.variables and "i" in p.variables

    def test_numeric_constants(self):
        p = _profile("y = 2 x + 10")
        assert "2" in p.constants and "10" in p.constants

    def test_plain_word_function(self):
        p = _profile("argmax f(x)")
        assert "argmax" in p.functions

    def test_tokens_retained(self):
        p = _profile(r"\alpha + x")
        assert p.tokens and p.normalized_tokens
        assert r"\alpha" in p.normalized_tokens


class TestEquationType:
    def test_piecewise(self):
        assert _profile(r"\begin{cases} x & x>0 \\ 0 & x \le 0 \end{cases}").equation_type is EquationType.PIECEWISE

    def test_matrix(self):
        assert _profile(r"A = \begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}").equation_type is EquationType.MATRIX_EQUATION

    def test_optimization(self):
        assert _profile(r"\theta^* = \operatorname{argmax}_\theta L(\theta)").equation_type is EquationType.OPTIMIZATION_OBJECTIVE

    def test_probability(self):
        assert _profile(r"P(A \cap B) = P(A)P(B)").equation_type is EquationType.PROBABILITY_EXPRESSION

    def test_vector(self):
        assert _profile(r"\vec{F} = m \vec{a}").equation_type is EquationType.VECTOR_EQUATION

    def test_recursive(self):
        assert _profile("f(n) = f(n-1) + f(n-2)").equation_type is EquationType.RECURSIVE_DEFINITION

    def test_scalar_equality(self):
        assert _profile("E = m c^2").equation_type is EquationType.SCALAR_EQUALITY

    def test_unknown_without_equals(self):
        assert _profile("x + y").equation_type is EquationType.UNKNOWN


class TestRobustness:
    def test_malformed_latex_does_not_raise(self):
        p = _profile(r"\frac{1}{")  # unbalanced
        assert p.equation_type is EquationType.UNKNOWN
        assert "frac" in p.functions

    def test_empty(self):
        p = _profile("")
        assert p.variables == [] and p.functions == []
        assert p.equation_type is EquationType.UNKNOWN
