"""Tests for requires_cross_modal_grounding detection in QueryAnalyzer.

Grounding = "place/map a structured reference (v1: table) onto an image". The
detector is deliberately CONSERVATIVE (precision over recall): it requires a
placement verb AND a reference signal AND an image signal. These tests pin both
the positive cases and the intentional misses (the recall gap is documented, not
accidental).
"""

from __future__ import annotations

from .query_analyzer import QueryAnalyzer


def _analyze(query: str):
    # bedrock_client=None: all queries here contain a rule keyword (table/figure/
    # graph/...), so rule-based classification fires — no Haiku fallback needed.
    return QueryAnalyzer(bedrock_client=None).analyze(query)


# --- Positive cases ---------------------------------------------------------

def test_map_table_onto_figure_is_grounding() -> None:
    intent = _analyze(
        "Using the population figures in Table 3.2, mark which regions on the "
        "map in Figure 4 are above the median"
    )
    assert intent.requires_cross_modal_grounding is True


def test_plot_data_onto_scatter_is_grounding() -> None:
    # No "figure N" and no global requires_image keyword here — the image signal
    # comes from the grounding-scoped noun pattern (scatter/plot).
    intent = _analyze("Plot the data points from the results table onto the scatter plot")
    assert intent.requires_cross_modal_grounding is True


def test_overlay_table_values_on_the_map() -> None:
    intent = _analyze("overlay the values in table 2 on the map")
    assert intent.requires_cross_modal_grounding is True


# --- Negative cases (each fails a different gate) ----------------------------

def test_image_comparison_is_not_grounding() -> None:
    # Two figures, comparison verb — no table/reference signal, no placement.
    intent = _analyze("compare figure 2.1 and figure 4.1")
    assert intent.requires_cross_modal_grounding is False


def test_plain_table_lookup_is_not_grounding() -> None:
    # Reference signal but no placement verb and no image signal.
    intent = _analyze("show table 3.2")
    assert intent.requires_cross_modal_grounding is False


def test_interpretation_without_placement_is_not_grounding() -> None:
    # Has both a table and an image noun, but no placement/relationship verb —
    # this is interpretation ("explain ... using ..."), a different prompt family.
    intent = _analyze("explain the diagram using table 2")
    assert intent.requires_cross_modal_grounding is False


def test_placement_verb_without_image_signal_is_not_grounding() -> None:
    # "highlight ... in ..." matches the placement pattern, but there is no image
    # signal — the two-signal AND-gate must suppress it.
    intent = _analyze("highlight the key points in the summary")
    assert intent.requires_cross_modal_grounding is False


def test_conservative_recall_gap_no_placement_verb() -> None:
    # DOCUMENTS the known v1 gap: a natural phrasing with no placement verb is
    # intentionally NOT detected (precision over recall). If this ever flips to
    # True, it's a deliberate recall broadening, not an accident.
    intent = _analyze("which points correspond to the values in Table 3.2?")
    assert intent.requires_cross_modal_grounding is False


def test_plain_image_question_is_not_grounding() -> None:
    intent = _analyze("what does the graph on page 3 show?")
    assert intent.requires_cross_modal_grounding is False


# --- Existing flags unaffected ----------------------------------------------

def test_grounding_does_not_set_comparison_flags() -> None:
    intent = _analyze(
        "Using Table 3.2, mark which regions on the map in Figure 4 are above the median"
    )
    assert intent.requires_cross_modal_grounding is True
    # Grounding is not a comparison — those flags stay off.
    assert intent.requires_table_comparison is False
    assert intent.requires_comparison is False


def test_non_grounding_query_defaults_false() -> None:
    intent = _analyze("what was covered this week?")
    assert intent.requires_cross_modal_grounding is False
