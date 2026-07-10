"""Tests for the cross-modal explanation faithfulness scorer (AC-3B).

``unsupported_numeric_values`` is the deterministic check the eval harness applies
to a REAL model's answer: for a no-numeric-label image + a table, every number in
the answer must come from the supplied artifacts. A non-empty result is an invented
number (the fabricated-latency failure this feature exists to prevent).
"""

from __future__ import annotations

from .scoring import unsupported_numeric_values


def test_all_numbers_supported_returns_empty():
    table = "Region | Population\nNorth | 100\nSouth | 200"
    answer = "North has 100 and South has 200, so North is smaller."
    assert unsupported_numeric_values(answer, [table]) == []


def test_invented_number_is_flagged():
    table = "Region | Population\nNorth | 100\nSouth | 200"
    # The image has no numeric labels; 512 appears nowhere in the artifacts.
    answer = "The map shows North at coordinate 512, matching the table."
    assert unsupported_numeric_values(answer, [table]) == ["512"]


def test_thousands_commas_normalized():
    table = "Algorithm | Time\nLinear | 11,800 ms"
    answer = "Linear scan takes 11800 ms per the table."
    assert unsupported_numeric_values(answer, [table]) == []


def test_decimals_supported_from_multiple_sources():
    table = "Input | O(1)\n100 | 0.01 ms"
    image_caption = "A latency curve"
    answer = "At 100 inputs the O(1) lookup is 0.01 ms (flat)."
    assert unsupported_numeric_values(answer, [table, image_caption]) == []


def test_no_numbers_in_answer_returns_empty():
    assert unsupported_numeric_values("The table's rows correspond to regions on the map.", ["Region\nNorth"]) == []


def test_multiple_invented_numbers_sorted():
    answer = "Values 3.5 and 42 and 7 appear on the plot."
    assert unsupported_numeric_values(answer, ["only 7 is real"]) == ["3.5", "42"]
