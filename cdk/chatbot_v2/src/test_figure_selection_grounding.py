"""Tests for cross-modal grounding display wiring in chatbot_v2 (T7).

Two things must hold for a grounding answer ("map Table 3.2 onto Figure 4"):
  1. the existing selectors attach BOTH the figure and the table (AC-7), and
  2. build_grounding_reinforcement nudges the generator to use the grounding —
     only when a table + a figure are shown together for a placement query.
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


_GROUNDING_QUERY = "map Table 3.2 onto the map in Figure 4"


class TestGroundingAttachesBothBlocks:
    """AC-7: a grounding answer surfaces the figure AND the table."""

    def _grounding_rr(self):
        return _rr(
            escalation_used=True,
            image_analyses=[{"image_s3_key": "s3://b/fig4.png"}],
            image_results=[{"retrieval_id": "fig4", "image_s3_key": "s3://b/fig4.png", "score": 0.9}],
            table_results=[{"retrieval_id": "tbl32", "score": 0.8, "headers": ["Region"], "rows": [["N"]], "summary": "s"}],
        )

    def test_select_figures_attaches_grounded_figure(self):
        assert fs.select_figures(self._grounding_rr(), _GROUNDING_QUERY) == ["fig4"]

    def test_select_tables_attaches_grounded_table(self):
        out = fs.select_tables(self._grounding_rr(), _GROUNDING_QUERY)
        assert [t["id"] for t in out] == ["tbl32"]
        assert out[0]["headers"] == ["Region"]


class TestBuildCrossModalReinforcement:
    _TABLE = [{"retrieval_id": "tbl32", "headers": ["Region"], "rows": [["N"]]}]
    _FIGS = ["fig4"]
    _EXPLANATION_QUERY = "how does Table 3.2 relate to Figure 4"

    def test_fires_for_placement_query_grounding(self):
        out = fs.build_cross_modal_reinforcement(self._TABLE, self._FIGS, _GROUNDING_QUERY)
        assert "Cross-modal analysis" in out
        assert "do not support" in out.lower()

    def test_fires_for_relational_query_explanation(self):
        out = fs.build_cross_modal_reinforcement(self._TABLE, self._FIGS, self._EXPLANATION_QUERY)
        assert "Cross-modal analysis" in out

    def test_empty_without_placement_or_relational_cue(self):
        # Both blocks present, but a plain lookup — neither placement nor relational.
        assert fs.build_cross_modal_reinforcement(self._TABLE, self._FIGS, "show table 3.2 and figure 4") == ""

    def test_empty_without_table(self):
        assert fs.build_cross_modal_reinforcement([], self._FIGS, _GROUNDING_QUERY) == ""

    def test_empty_without_figure(self):
        assert fs.build_cross_modal_reinforcement(self._TABLE, [], self._EXPLANATION_QUERY) == ""
