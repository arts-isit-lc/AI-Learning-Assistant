"""Tests for requires_table_comparison detection in QueryAnalyzer."""

from __future__ import annotations

from .query_analyzer import QueryAnalyzer


def _analyze(query: str):
    # bedrock_client=None: these queries all contain "table", so rule-based
    # classification fires and no Haiku fallback is needed.
    return QueryAnalyzer(bedrock_client=None).analyze(query)


def test_two_tables_and_compare_verb_is_table_comparison() -> None:
    intent = _analyze("compare table 2.1 and table 3.1")
    assert intent.requires_table_comparison is True
    # Both table references are parsed.
    assert [(r.ref_type, r.number) for r in intent.figure_references] == [
        ("table", "2.1"),
        ("table", "3.1"),
    ]


def test_two_tables_without_compare_verb_is_not_comparison() -> None:
    intent = _analyze("explain table 2.1 and table 3.1")
    assert intent.requires_table_comparison is False


def test_single_table_is_not_comparison() -> None:
    intent = _analyze("what does table 2.1 show?")
    assert intent.requires_table_comparison is False


def test_mixed_table_and_figure_is_not_table_comparison() -> None:
    # Only one TABLE reference -> not a table comparison (mixed-type out of scope).
    intent = _analyze("compare table 2.1 and figure 4.1")
    assert intent.requires_table_comparison is False
    # It is still a multi-reference (image) query — that path is untouched.
    assert intent.requires_multi_image is True


def test_same_table_twice_dedupes_to_one_referent() -> None:
    intent = _analyze("compare table 2.1 with table 2.1")
    assert intent.requires_table_comparison is False


def test_no_reference_query_defaults_false() -> None:
    intent = _analyze("what was covered this week?")
    assert intent.requires_table_comparison is False
