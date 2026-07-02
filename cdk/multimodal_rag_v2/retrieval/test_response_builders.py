"""Tests for the retrieval handler's structured table/formula response builders
(Issues #2 and #6).

The handler pulls in runtime-only deps (langchain_*, psycopg2) at module load via
its search/reasoning imports; those are stubbed so the pure builder functions can
be imported and tested in isolation.
"""
from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

for _m in [
    "langchain_postgres", "langchain_aws", "langchain_core", "langchain_community",
    "langchain_classic", "psycopg2",
]:
    sys.modules.setdefault(_m, MagicMock())

from ..models.data_models import ElementType  # noqa: E402
from . import handler  # noqa: E402


def _result(element_type, retrieval_id, parent, score=0.9, metadata=None, content="", image_s3_key=None):
    return SimpleNamespace(
        element_type=element_type,
        retrieval_id=retrieval_id,
        parent_element_id=parent,
        score=score,
        metadata=metadata or {},
        content=content,
        image_s3_key=image_s3_key,
    )


class TestBuildTableResults:
    def test_dedups_by_parent_and_surfaces_structure(self):
        results = [
            _result(
                ElementType.TABLE, "t-sum", "tbl-1", 0.92,
                {
                    "table_headers": ["Algorithm", "Big-O"],
                    "table_rows": [["Mergesort", "n log n"]],
                    "table_summary": "Sorting complexity",
                    "provenance_page_num": 3,
                    "module_id": "m1",
                },
                "Sorting complexity",
            ),
            # Same table, a column unit — must be deduped away
            _result(
                ElementType.TABLE, "t-col", "tbl-1", 0.81,
                {"table_headers": ["Algorithm", "Big-O"], "table_rows": [["Mergesort", "n log n"]]},
                "Algorithm: Mergesort",
            ),
            _result(ElementType.TEXT, "x", "txt-1", 0.7, {}, "some text"),
        ]
        out = handler._build_table_results(results)
        assert len(out) == 1
        assert out[0]["retrieval_id"] == "t-sum"
        assert out[0]["headers"] == ["Algorithm", "Big-O"]
        assert out[0]["rows"] == [["Mergesort", "n log n"]]
        assert out[0]["summary"] == "Sorting complexity"
        assert out[0]["page_num"] == 3

    def test_empty_when_no_tables(self):
        assert handler._build_table_results([_result(ElementType.TEXT, "x", "t", 0.9)]) == []


class TestBuildFormulaResults:
    def test_surfaces_latex_repr(self):
        results = [
            _result(
                ElementType.FORMULA, "f1", "fml-1", 0.9,
                {"latex_repr": "E=mc^2", "page_num": 2, "module_id": "m1"}, "E=mc^2",
            )
        ]
        out = handler._build_formula_results(results)
        assert len(out) == 1
        assert out[0]["latex"] == "E=mc^2"
        assert out[0]["page_num"] == 2

    def test_falls_back_to_content_when_no_latex(self):
        results = [_result(ElementType.FORMULA, "f1", "fml-1", 0.9, {}, "x^2 + y^2 = z^2")]
        out = handler._build_formula_results(results)
        assert out[0]["latex"] == "x^2 + y^2 = z^2"

    def test_empty_when_no_formulas(self):
        assert handler._build_formula_results([_result(ElementType.IMAGE, "i", "p", 0.9)]) == []


class TestBuildImageResults:
    def test_includes_description_and_page(self):
        results = [
            _result(
                ElementType.IMAGE, "img-1", "img-p", 0.95,
                {"provenance_page_num": 5, "module_id": "m1"},
                content="Figure 4.1: bar chart of exam scores",
                image_s3_key="s3://bucket/fig41.png",
            ),
            _result(ElementType.TEXT, "x", "t", 0.7, {}, "some text"),
        ]
        out = handler._build_image_results(results)
        assert len(out) == 1
        assert out[0]["retrieval_id"] == "img-1"
        assert out[0]["image_s3_key"] == "s3://bucket/fig41.png"
        assert out[0]["page_num"] == 5
        # caption-injected description is surfaced for response-text grounding
        assert out[0]["description"] == "Figure 4.1: bar chart of exam scores"

    def test_excludes_images_without_s3_key(self):
        results = [_result(ElementType.IMAGE, "img-2", "p", 0.9, {}, "desc", image_s3_key=None)]
        assert handler._build_image_results(results) == []
