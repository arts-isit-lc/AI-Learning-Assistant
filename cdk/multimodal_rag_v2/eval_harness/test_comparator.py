"""Tests for the eval-harness comparator + golden set (Phase 0b)."""
from __future__ import annotations

import json
import os

import pytest

from .comparator import (
    OutputSample,
    compare_outputs,
    jaccard,
)


class TestJaccard:
    def test_identical(self):
        assert jaccard(["a", "b"], ["a", "b"]) == 1.0

    def test_disjoint(self):
        assert jaccard(["a"], ["b"]) == 0.0

    def test_partial(self):
        # {a,b} vs {b,c} -> intersection 1, union 3
        assert jaccard(["a", "b"], ["b", "c"]) == pytest.approx(1 / 3)

    def test_both_empty_is_one(self):
        assert jaccard([], []) == 1.0


class TestCompareOutputs:
    def _base(self):
        return OutputSample(
            query="q", answer="a fairly complete answer", source_ids=["s1", "s2", "s3"], latency_ms=8000.0
        )

    def test_equivalent_candidate_passes(self):
        base = self._base()
        cand = OutputSample(query="q", answer="a fairly complete answer!", source_ids=["s1", "s2", "s3"], latency_ms=3000.0)
        result = compare_outputs(base, cand)
        assert result.passed
        assert result.source_overlap == 1.0
        # latency win is reported (negative delta) but not the pass criterion
        assert result.latency_delta_ms == pytest.approx(-5000.0)

    def test_source_regression_fails(self):
        base = self._base()
        cand = OutputSample(query="q", answer="x" * 24, source_ids=["z9"], latency_ms=3000.0)
        result = compare_outputs(base, cand)
        assert not result.passed
        assert any("source overlap" in r for r in result.reasons)

    def test_empty_candidate_answer_fails(self):
        base = self._base()
        cand = OutputSample(query="q", answer="", source_ids=["s1", "s2", "s3"])
        result = compare_outputs(base, cand)
        assert not result.passed
        assert any("empty" in r for r in result.reasons)

    def test_answer_too_long_fails(self):
        base = self._base()
        cand = OutputSample(query="q", answer="x" * 10000, source_ids=["s1", "s2", "s3"])
        result = compare_outputs(base, cand)
        assert not result.passed
        assert any("length ratio" in r for r in result.reasons)

    def test_latency_never_fails_gate_on_its_own(self):
        base = self._base()
        slower = OutputSample(query="q", answer="a fairly complete answer", source_ids=["s1", "s2", "s3"], latency_ms=99999.0)
        result = compare_outputs(base, slower)
        assert result.passed  # content equivalent; latency alone doesn't fail
        assert result.latency_delta_ms > 0


class TestGoldenSet:
    def test_golden_set_loads_and_is_well_formed(self):
        path = os.path.join(os.path.dirname(__file__), "golden_set.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        assert len(data) >= 8
        for entry in data:
            assert set(entry) >= {"query", "intent", "expects_image"}
            assert isinstance(entry["query"], str) and entry["query"]
            assert isinstance(entry["expects_image"], bool)
        # Covers both image and non-image intents (needed to exercise #9 gating).
        assert any(e["expects_image"] for e in data)
        assert any(not e["expects_image"] for e in data)
