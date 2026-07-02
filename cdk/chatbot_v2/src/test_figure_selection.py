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
        escalation_used=False, image_analyses=[], image_results=[],
        table_results=[], formula_results=[],
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


class TestSelectFigures:
    def test_escalated_image_attaches_regardless_of_score(self):
        rr = _rr(escalation_used=True, image_results=[{"retrieval_id": "i1", "score": 0.1}])
        assert fs.select_figures(rr, "tell me about it") == ["i1"]

    def test_figure_ref_attaches_at_or_above_intent_floor(self):
        rr = _rr(image_results=[{"retrieval_id": "i1", "score": 0.55}])
        assert fs.select_figures(rr, "show me figure 2") == ["i1"]

    def test_figure_ref_below_floor_excluded(self):
        rr = _rr(image_results=[{"retrieval_id": "i1", "score": 0.3}])
        assert fs.select_figures(rr, "show me the diagram") == []

    def test_no_ref_requires_high_confidence(self):
        assert fs.select_figures(_rr(image_results=[{"retrieval_id": "i1", "score": 0.6}]), "what is recursion?") == []
        assert fs.select_figures(_rr(image_results=[{"retrieval_id": "i2", "score": 0.85}]), "what is recursion?") == ["i2"]

    def test_none_result(self):
        assert fs.select_figures(None, "figure") == []

    def test_specific_figure_ref_shows_only_escalated_image(self):
        # Reported bug: "explain figure 4.1" returned 4.1 plus sibling figures
        # 2.1/3.1 that scored higher. Only the escalated (analysed) image shows.
        rr = _rr(
            escalation_used=True,
            image_analyses=[
                {"image_s3_key": "s3://b/fig41.png", "analysis": "binary search", "confidence": 0.9}
            ],
            image_results=[
                {"retrieval_id": "fig21", "score": 0.72, "image_s3_key": "s3://b/fig21.png"},
                {"retrieval_id": "fig31", "score": 0.70, "image_s3_key": "s3://b/fig31.png"},
                {"retrieval_id": "fig41", "score": 0.68, "image_s3_key": "s3://b/fig41.png"},
            ],
        )
        assert fs.select_figures(rr, "can you explain figure 4.1 to me?") == ["fig41"]

    def test_specific_ref_escalated_match_beats_higher_scoring_siblings(self):
        # The escalated image wins even when it is the lowest-scoring candidate.
        rr = _rr(
            escalation_used=True,
            image_analyses=[{"image_s3_key": "s3://b/target.png", "analysis": "x", "confidence": 0.8}],
            image_results=[
                {"retrieval_id": "other", "score": 0.95, "image_s3_key": "s3://b/other.png"},
                {"retrieval_id": "target", "score": 0.40, "image_s3_key": "s3://b/target.png"},
            ],
        )
        assert fs.select_figures(rr, "what is in figure 7.2?") == ["target"]

    def test_specific_ref_without_escalation_falls_back_to_single_top_image(self):
        rr = _rr(image_results=[
            {"retrieval_id": "a", "score": 0.55, "image_s3_key": "s3://b/a.png"},
            {"retrieval_id": "b", "score": 0.80, "image_s3_key": "s3://b/b.png"},
        ])
        # Specific reference, nothing escalated -> a single best-scoring image, not both.
        assert fs.select_figures(rr, "explain figure 4.1") == ["b"]

    def test_specific_ref_all_below_floor_shows_nothing(self):
        rr = _rr(image_results=[{"retrieval_id": "a", "score": 0.2, "image_s3_key": "s3://b/a.png"}])
        assert fs.select_figures(rr, "explain figure 4.1") == []

    def test_generic_diagram_query_still_allows_multiple_figures(self):
        rr = _rr(
            escalation_used=True,
            image_results=[
                {"retrieval_id": f"i{i}", "score": 0.9, "image_s3_key": f"s3://b/{i}.png"}
                for i in range(3)
            ],
        )
        # No specific number -> generic path may surface several figures.
        assert fs.select_figures(rr, "show me some diagrams") == ["i0", "i1", "i2"]


class TestHarmonizedAndConfigurable:
    def test_formula_with_intent_below_floor_excluded(self):
        # Harmonized: even with formula intent, below the intent floor is excluded.
        rr = _rr(formula_results=[{"retrieval_id": "f1", "score": 0.3, "latex": "x", "content": "x"}])
        assert fs.select_formulas(rr, "show the equation") == []

    def test_high_confidence_threshold_is_configurable(self, monkeypatch):
        # Raising the bar means a 0.85 table without intent no longer attaches.
        monkeypatch.setattr(fs, "_HIGH_CONFIDENCE_THRESHOLD", 0.95)
        rr = _rr(table_results=[{"retrieval_id": "t1", "score": 0.85, "headers": ["A"], "rows": [["1"]]}])
        assert fs.select_tables(rr, "what is recursion?") == []

    def test_intent_floor_is_configurable(self, monkeypatch):
        # select_formulas reads the intent floor at call time, so the env-backed
        # module value drives it. Raising it excludes a mid-scoring formula.
        monkeypatch.setattr(fs, "_INTENT_SCORE_FLOOR", 0.7)
        rr = _rr(formula_results=[{"retrieval_id": "f1", "score": 0.6, "latex": "x", "content": "x"}])
        assert fs.select_formulas(rr, "show the equation") == []

    def test_log_candidate_scores_handles_empty(self):
        fs._log_candidate_scores("table", [])
        fs._log_candidate_scores("table", None)


class TestBuildFigureGrounding:
    def test_formats_selected_figures_with_description(self):
        rr = _rr(image_results=[
            {"retrieval_id": "img-1", "score": 0.9, "image_s3_key": "s3://b/f41.png",
             "page_num": 41, "description": "Figure 4.1: bar chart of exam scores"},
            {"retrieval_id": "img-2", "score": 0.5, "image_s3_key": "s3://b/f99.png",
             "page_num": 99, "description": "Figure 9.9: unrelated"},
        ])
        out = fs.build_figure_grounding(rr, ["img-1"])
        assert "Figures shown to the student" in out
        assert "Figure 4.1: bar chart of exam scores" in out
        assert "page 41" in out
        # only the selected figure is grounded
        assert "9.9" not in out

    def test_empty_when_no_selected_ids(self):
        rr = _rr(image_results=[{"retrieval_id": "img-1", "description": "d", "page_num": 1}])
        assert fs.build_figure_grounding(rr, []) == ""

    def test_empty_when_selected_figure_has_no_description(self):
        rr = _rr(image_results=[{"retrieval_id": "img-1", "description": "", "page_num": 1}])
        assert fs.build_figure_grounding(rr, ["img-1"]) == ""

    def test_none_result(self):
        assert fs.build_figure_grounding(None, ["img-1"]) == ""
