"""Tests for requires_formula_comparison detection in QueryAnalyzer (Phase 1)."""

from __future__ import annotations

from .query_analyzer import QueryAnalyzer


def _analyze(query: str):
    return QueryAnalyzer(bedrock_client=None).analyze(query)


def test_two_numbered_equations_and_compare_verb() -> None:
    intent = _analyze("compare equation 3.4 and equation 5.2")
    assert intent.requires_formula_comparison is True
    assert [(r.number, r.keyword) for r in intent.formula_references] == [
        ("3.4", "equation"),
        ("5.2", "equation"),
    ]
    # The formula path must NEVER set requires_image (guard preserved).
    assert intent.requires_image is False


def test_keyword_only_named_equations_with_verb() -> None:
    # No numbers, but "equation" (requires_formula) + "compare" -> comparison.
    intent = _analyze("compare the momentum equation with the energy equation")
    assert intent.requires_formula_comparison is True
    assert intent.formula_references == []  # nothing numbered to resolve by
    assert intent.requires_image is False


def test_single_numbered_equation_no_verb_is_not_comparison() -> None:
    intent = _analyze("what does equation 3.4 represent?")
    assert intent.requires_formula_comparison is False
    assert [r.number for r in intent.formula_references] == ["3.4"]


def test_formula_keyword_with_compare_verb_triggers() -> None:
    intent = _analyze("compare the formula for kinetic energy")
    assert intent.requires_formula_comparison is True


def test_eq_and_eqn_abbreviations() -> None:
    intent = _analyze("compare eq. 3 and eqn 4")
    assert intent.requires_formula_comparison is True
    assert [(r.number, r.keyword) for r in intent.formula_references] == [
        ("3", "eq"),
        ("4", "eqn"),
    ]


def test_dedupes_and_bounds_numbers() -> None:
    intent = _analyze("compare equation 3.4, equation 3.4 and equation 5.2")
    assert [r.number for r in intent.formula_references] == ["3.4", "5.2"]


def test_figure_comparison_is_not_formula_comparison() -> None:
    intent = _analyze("compare figure 2.1 and figure 4.1")
    assert intent.requires_formula_comparison is False
    assert intent.formula_references == []


def test_plain_query_defaults_false() -> None:
    intent = _analyze("what was covered this week?")
    assert intent.requires_formula_comparison is False
    assert intent.formula_references == []
