"""Tests for the figure-eval dataset schema + loader (Step 0 / Phase 1)."""
from __future__ import annotations

import json

import pytest

from .figure_dataset import (
    REQUIRED_FIELDS,
    FigureEvalItem,
    load_figure_eval_set,
)


def _valid_entry(**overrides) -> dict:
    entry = {
        "query": "What does Figure 1 show?",
        "figure_ref": "figure 1",
        "image_s3_key": "k/fig1.png",
        "expected_figure_id": "rid-1",
        "ground_truth_facts": ["fact a"],
    }
    entry.update(overrides)
    return entry


def _write(tmp_path, data) -> str:
    path = tmp_path / "ds.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return str(path)


class TestLoader:
    def test_loads_valid_entries(self, tmp_path):
        path = _write(tmp_path, [_valid_entry(), _valid_entry(query="Q2", expected_concepts=["c"])])
        items = load_figure_eval_set(path)
        assert len(items) == 2
        assert isinstance(items[0], FigureEvalItem)
        assert items[0].ground_truth_facts == ["fact a"]
        assert items[1].expected_concepts == ["c"]

    def test_missing_required_field_raises(self, tmp_path):
        bad = _valid_entry()
        del bad["expected_figure_id"]
        path = _write(tmp_path, [bad])
        with pytest.raises(ValueError) as exc:
            load_figure_eval_set(path)
        assert "expected_figure_id" in str(exc.value)

    def test_empty_ground_truth_facts_raises(self, tmp_path):
        path = _write(tmp_path, [_valid_entry(ground_truth_facts=[])])
        with pytest.raises(ValueError) as exc:
            load_figure_eval_set(path)
        assert "ground_truth_facts" in str(exc.value)

    def test_defaults_applied_for_optional_fields(self, tmp_path):
        path = _write(tmp_path, [_valid_entry()])
        item = load_figure_eval_set(path)[0]
        assert item.expected_concepts == []
        assert item.course_id == "" and item.module_id == ""


class TestSeedFile:
    def test_seed_file_loads_and_is_well_formed(self):
        # The committed seed file must always satisfy the loader contract.
        items = load_figure_eval_set()
        assert len(items) >= 1
        for item in items:
            assert item.query
            assert item.ground_truth_facts  # non-empty (required by loader)

    def test_required_fields_constant_is_the_contract(self):
        # Guards against the loader and its documented contract drifting apart.
        assert REQUIRED_FIELDS == {
            "query",
            "figure_ref",
            "image_s3_key",
            "expected_figure_id",
            "ground_truth_facts",
        }
