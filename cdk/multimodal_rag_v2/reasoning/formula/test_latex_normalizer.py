"""Tests for the LaTeX normalizer."""

from __future__ import annotations

from .latex_normalizer import normalize


def test_strips_math_delimiters():
    assert normalize("$$ x + y $$") == "x + y"
    assert normalize(r"\[ a = b \]") == "a = b"
    assert normalize(r"\( E = mc^2 \)") == "E = mc^2"
    assert normalize("$x$") == "x"


def test_removes_left_right():
    assert normalize(r"\left( x \right)") == "( x )"


def test_removes_spacing_macros():
    assert normalize(r"a \, b \; c \quad d \qquad e") == "a b c d e"


def test_removes_braces():
    assert normalize(r"\frac{a}{b}") == r"\frac a b"


def test_collapses_whitespace():
    assert normalize("a    +\t\n b") == "a + b"


def test_empty_and_noneish():
    assert normalize("") == ""
    assert normalize(None) == ""  # type: ignore[arg-type]


def test_idempotent():
    once = normalize(r"$$ \left( \frac{a}{b} \right) \quad = c $$")
    assert normalize(once) == once
