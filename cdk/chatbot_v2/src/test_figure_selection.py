"""Tests for chatbot figure/table/formula block selection (Issues #2, #6).

figure_selection only depends on `re` + powertools, so it imports directly.
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))

import figure_selection as fs  # noqa: E402


def _rr(**kw):
    base = dict(
        escalation_used=False, image_results=[], table_results=[], formula_results=[]
    )
    base.update(kw)
    return SimpleNamespace(**base)


class TestSelectTables:
    def test_selects_structured_table_when_query_references_table(self):
        rr = _rr(table_results=[
            {"retrieval_id": "t1", "score": 0.6, "headers": ["A"], "rows": [["1"]],
             "summary": "s", "page_num": 2}
        ])
        out = fs.select_tables(rr, "show me the table of results")
        assert len(out) == 1
        assert out[0]["type"] == "table"
        assert out[0]["id"] == "t1"
        assert out[0]["headers"] == ["A"]
        assert out[0]["rows"] == [["1"]]

    def test_no_table_ref_and_low_score_returns_empty(self):
        rr = _rr(table_results=[{"retrieval_id": "t1", "score": 0.6, "headers": ["A"], "rows": [["1"]]}])
        assert fs.select_tables(rr, "what is recursion?") == []

    def test_high_score_attaches_without_table_ref(self):
        rr = _rr(table_results=[{"retrieval_id": "t1", "score": 0.85, "headers": ["A"], "rows": [["1"]]}])
        assert len(fs.select_tables(rr, "what is recursion?")) == 1

    def test_falls_back_to_raw_content_when_no_structure(self):
        rr = _rr(table_results=[{"retrieval_id": "t1", "score": 0.9, "headers": [], "rows": [], "content": "a | b"}])
        out = fs.select_tables(rr, "compare the data")
        assert out[0]["content"] == "a | b"

    def test_respects_max_tables(self):
        rr = _rr(table_results=[
            {"retrieval_id": f"t{i}", "score": 0.9, "headers": ["A"], "rows": [["1"]]} for i in range(5)
        ])
        assert len(fs.select_tables(rr, "table", max_tables=2)) == 2

    def test_empty_when_no_table_results(self):
        assert fs.select_tables(_rr(), "table") == []

    def test_none_result(self):
        assert fs.select_tables(None, "table") == []


class TestSelectFormulas:
    def test_selects_formula_when_query_references_equation(self):
        rr = _rr(formula_results=[
            {"retrieval_id": "f1", "score": 0.6, "latex": "E=mc^2", "content": "E=mc^2", "page_num": 1}
        ])
        out = fs.select_formulas(rr, "show the equation")
        assert len(out) == 1
        assert out[0]["type"] == "formula"
        assert out[0]["latex"] == "E=mc^2"

    def test_no_formula_ref_low_score_empty(self):
        rr = _rr(formula_results=[{"retrieval_id": "f1", "score": 0.6, "latex": "x", "content": "x"}])
        assert fs.select_formulas(rr, "what is a tree?") == []

    def test_high_score_attaches(self):
        rr = _rr(formula_results=[{"retrieval_id": "f1", "score": 0.85, "latex": "x", "content": "x"}])
        assert len(fs.select_formulas(rr, "what is a tree?")) == 1

    def test_latex_falls_back_to_content(self):
        rr = _rr(formula_results=[{"retrieval_id": "f1", "score": 0.9, "latex": "", "content": "a^2+b^2"}])
        out = fs.select_formulas(rr, "derive the formula")
        assert out[0]["latex"] == "a^2+b^2"

    def test_empty_when_no_formula_results(self):
        assert fs.select_formulas(_rr(), "equation") == []
