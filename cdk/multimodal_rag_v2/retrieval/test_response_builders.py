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


# ---------------------------------------------------------------------------
# T4: multi-image response assembly (union resolved figures, derive wire shape)
# ---------------------------------------------------------------------------


class TestDedupeByRetrievalId:
    def test_drops_later_duplicates_preserving_order(self):
        a = _result(ElementType.IMAGE, "r1", "p", image_s3_key="s3://b/1.png")
        b = _result(ElementType.IMAGE, "r2", "p", image_s3_key="s3://b/2.png")
        a_dup = _result(ElementType.IMAGE, "r1", "p", image_s3_key="s3://b/1.png")
        out = handler._dedupe_by_retrieval_id([a, b, a_dup])
        assert [r.retrieval_id for r in out] == ["r1", "r2"]


class TestImageResponsePartsSingle:
    """SINGLE path is unchanged: image_analyses verbatim, image_results from final only."""

    def test_single_path_unchanged(self):
        ia = SimpleNamespace(image_s3_key="s3://b/1.png", analysis="desc", confidence=0.9)
        reasoning_result = SimpleNamespace(vision_analysis=None, image_analyses=[ia])
        final = [
            _result(
                ElementType.IMAGE, "img-1", "p", 0.95,
                {"provenance_page_num": 5}, "Fig 1", "s3://b/1.png",
            )
        ]
        wire, image_results = handler._image_response_parts(reasoning_result, final)
        assert wire == [{"image_s3_key": "s3://b/1.png", "analysis": "desc", "confidence": 0.9}]
        assert [r["retrieval_id"] for r in image_results] == ["img-1"]


class TestImageResponsePartsMulti:
    """MULTI path: resolved figures union into image_results; wire derived from them."""

    def test_db_lookup_figure_appears_in_image_results(self):
        # Resolved via a direct DB lookup -> NOT present in final_results (the gap R7 fixes).
        db_img = _result(
            ElementType.IMAGE, "db-img", "p", 1.0,
            {"provenance_page_num": 2, "module_id": "m1"}, "Figure 4.1", "s3://b/41.png",
        )
        vision_analysis = SimpleNamespace(resolved_images=[db_img], confidence=0.9)
        reasoning_result = SimpleNamespace(vision_analysis=vision_analysis, image_analyses=[])
        final = [_result(ElementType.TEXT, "t1", "p", 0.7, {}, "text")]  # no ranked images

        wire, image_results = handler._image_response_parts(reasoning_result, final)
        ids = [r["retrieval_id"] for r in image_results]
        assert "db-img" in ids  # resolvable retrieval_id surfaced for display
        assert wire == [{"image_s3_key": "s3://b/41.png", "analysis": "", "confidence": 0.9}]

    def test_unions_and_dedupes_with_ranked_images(self):
        ranked_img = _result(ElementType.IMAGE, "img-1", "p", 0.9, {}, "F1", "s3://b/1.png")
        resolved_dup = _result(ElementType.IMAGE, "img-1", "p", 1.0, {}, "F1", "s3://b/1.png")
        resolved_new = _result(ElementType.IMAGE, "img-2", "p", 1.0, {}, "F2", "s3://b/2.png")
        vision_analysis = SimpleNamespace(
            resolved_images=[resolved_dup, resolved_new], confidence=0.8
        )
        reasoning_result = SimpleNamespace(vision_analysis=vision_analysis, image_analyses=[])

        wire, image_results = handler._image_response_parts(reasoning_result, [ranked_img])
        ids = [r["retrieval_id"] for r in image_results]
        assert ids.count("img-1") == 1  # deduped
        assert "img-2" in ids
        assert {w["image_s3_key"] for w in wire} == {"s3://b/1.png", "s3://b/2.png"}


class TestTableResultsWithComparison:
    """_table_results_with_comparison unions resolved comparison tables (T8)."""

    def _reasoning_result(self, resolved):
        # comparison_type is required on the real StructuredComparison; the union
        # is now type-scoped, so the stub must carry it.
        from ..models.data_models import ComparisonType
        return SimpleNamespace(
            structured_comparison=SimpleNamespace(
                comparison_type=ComparisonType.TABLE, resolved_results=resolved
            )
        )

    def test_no_comparison_matches_plain_builder(self):
        finals = [
            _result(
                ElementType.TABLE, "t1", "tbl-1", 0.9,
                {"table_headers": ["a"], "table_rows": [["1"]], "table_summary": "s"}, "x",
            )
        ]
        rr = SimpleNamespace(structured_comparison=None)
        assert handler._table_results_with_comparison(rr, finals) == handler._build_table_results(finals)

    def test_unions_resolved_tables_absent_from_finals(self):
        # Both compared tables were resolved by DB lookup (not in final_results).
        finals = [_result(ElementType.TEXT, "x", "txt", 0.5, {}, "t")]
        resolved = [
            _result(ElementType.TABLE, "r-21", "tbl-21", 1.0, {"table_headers": ["id"], "table_summary": "T2.1"}, "Table 2.1"),
            _result(ElementType.TABLE, "r-31", "tbl-31", 1.0, {"table_headers": ["id"], "table_summary": "T3.1"}, "Table 3.1"),
        ]
        out = handler._table_results_with_comparison(self._reasoning_result(resolved), finals)
        assert [b["retrieval_id"] for b in out] == ["r-21", "r-31"]

    def test_dedupes_resolved_against_finals_by_parent(self):
        # Same physical table (parent tbl-21) in both resolved and finals -> one
        # block, and the resolved (prepended, authoritative) unit wins.
        resolved = [_result(ElementType.TABLE, "r-21", "tbl-21", 1.0, {"table_headers": ["id"]}, "resolved")]
        finals = [_result(ElementType.TABLE, "f-21", "tbl-21", 0.8, {"table_headers": ["id"]}, "final")]
        out = handler._table_results_with_comparison(self._reasoning_result(resolved), finals)
        assert len(out) == 1
        assert out[0]["retrieval_id"] == "r-21"


from ..models.data_models import ComparisonType  # noqa: E402


class TestFormulaResultsWithComparison:
    """_formula_results_with_comparison unions resolved formulas; type-scoped (T7)."""

    def _rr(self, comparison_type, resolved):
        return SimpleNamespace(
            structured_comparison=SimpleNamespace(
                comparison_type=comparison_type, resolved_results=resolved
            )
        )

    def test_unions_resolved_formulas_absent_from_finals(self):
        finals = [_result(ElementType.TEXT, "x", "txt", 0.5, {}, "t")]
        resolved = [
            _result(ElementType.FORMULA, "rf1", "pf1", 1.0, {"latex_repr": "a=b"}, "a=b"),
            _result(ElementType.FORMULA, "rf2", "pf2", 1.0, {"latex_repr": "c=d"}, "c=d"),
        ]
        out = handler._formula_results_with_comparison(self._rr(ComparisonType.FORMULA, resolved), finals)
        assert [b["retrieval_id"] for b in out] == ["rf1", "rf2"]

    def test_no_comparison_matches_plain_builder(self):
        finals = [_result(ElementType.FORMULA, "f1", "p1", 0.9, {"latex_repr": "a=b"}, "a=b")]
        rr = SimpleNamespace(structured_comparison=None)
        assert handler._formula_results_with_comparison(rr, finals) == handler._build_formula_results(finals)

    def test_table_comparison_does_not_leak_into_formula_results(self):
        finals = [_result(ElementType.FORMULA, "f1", "p1", 0.9, {"latex_repr": "a=b"}, "a=b")]
        table_resolved = [_result(ElementType.TABLE, "t1", "tp1", 1.0, {"table_headers": ["h"]}, "T")]
        rr = self._rr(ComparisonType.TABLE, table_resolved)
        assert handler._formula_results_with_comparison(rr, finals) == handler._build_formula_results(finals)

    def test_formula_comparison_does_not_leak_into_table_results(self):
        finals = [_result(ElementType.TABLE, "t1", "tp1", 0.9,
                          {"table_headers": ["h"], "table_rows": [["1"]], "table_summary": "s"}, "T")]
        formula_resolved = [_result(ElementType.FORMULA, "rf1", "pf1", 1.0, {"latex_repr": "a=b"}, "a=b")]
        rr = self._rr(ComparisonType.FORMULA, formula_resolved)
        assert handler._table_results_with_comparison(rr, finals) == handler._build_table_results(finals)


class TestHandlerFormulaEngineWiring:
    """The retrieval handler's engine must register FORMULA (Phase 1 gap) and
    wire the Tier-2 checker only when MATH_COMPUTE_FUNCTION_NAME is set (P2-T3)."""

    def test_formula_and_table_both_registered(self):
        from ..models.data_models import ComparisonType
        assert ComparisonType.TABLE in handler._comparison_engine._comparators
        assert ComparisonType.FORMULA in handler._comparison_engine._comparators
        assert ComparisonType.FORMULA in handler._comparison_engine._resolvers

    def test_equivalence_checker_none_without_env(self):
        # MATH_COMPUTE_FUNCTION_NAME is unset under test -> Tier 1 only.
        assert handler._equivalence_checker is None

    def test_formula_comparison_runs_via_fallback(self):
        from ..models.data_models import ComparisonType, ElementType, EquivalenceStatus, QueryIntent
        intent = QueryIntent()
        intent.requires_formula_comparison = True
        ranked = [
            _result(ElementType.FORMULA, "f1", "p1", 0.9, {"latex_repr": "a = b"}, "a = b"),
            _result(ElementType.FORMULA, "f2", "p2", 0.9, {"latex_repr": "c = d"}, "c = d"),
        ]
        sc = handler._comparison_engine.compare(intent, ranked, None)
        assert sc is not None
        assert sc.comparison_type is ComparisonType.FORMULA
        assert len(sc.referents) == 2
        # No checker in tests -> equivalence stays UNKNOWN (lexical Tier 1 only).
        assert sc.facts.equivalence.status is EquivalenceStatus.UNKNOWN


# ---------------------------------------------------------------------------
# T6: cross-modal grounding response assembly
# ---------------------------------------------------------------------------

from ..models.data_models import (  # noqa: E402
    GroundedArtifact,
    GroundingResolution,
    ResolutionConfidence,
    VisionMode,
)


def _grounding_reasoning_result(resolved_table=None, resolved_image=None):
    """A reasoning_result stub carrying a CROSS_MODAL vision_analysis."""
    resolved_artifacts = []
    if resolved_table is not None:
        resolved_artifacts.append(
            GroundingResolution(
                artifact=GroundedArtifact(ElementType.TABLE, "Table 3.2", {"headers": ["R"]}),
                ranked_result=resolved_table,
                confidence=ResolutionConfidence.HIGH,
            )
        )
    va = SimpleNamespace(
        mode=VisionMode.CROSS_MODAL,
        resolved_images=[resolved_image] if resolved_image is not None else [],
        resolved_artifacts=resolved_artifacts,
        confidence=0.9,
    )
    return SimpleNamespace(structured_comparison=None, vision_analysis=va, image_analyses=[])


class TestTableResultsWithGrounding:
    """_table_results_with_comparison also unions a grounded table (routed by type)."""

    def test_grounded_table_absent_from_finals_is_surfaced(self):
        # The grounded table was resolved by DB lookup -> not in final_results.
        finals = [_result(ElementType.TEXT, "x", "txt", 0.5, {}, "t")]
        grounded = _result(
            ElementType.TABLE, "g-tbl", "tbl-g", 1.0,
            {"table_headers": ["Region"], "table_rows": [["N"]], "table_summary": "s"},
            "Table 3.2",
        )
        rr = _grounding_reasoning_result(resolved_table=grounded)
        out = handler._table_results_with_comparison(rr, finals)
        assert [b["retrieval_id"] for b in out] == ["g-tbl"]
        assert out[0]["headers"] == ["Region"]

    def test_grounded_table_deduped_against_finals_by_parent(self):
        grounded = _result(ElementType.TABLE, "g-tbl", "tbl-g", 1.0, {"table_headers": ["R"]}, "resolved")
        final_same = _result(ElementType.TABLE, "f-tbl", "tbl-g", 0.8, {"table_headers": ["R"]}, "final")
        rr = _grounding_reasoning_result(resolved_table=grounded)
        out = handler._table_results_with_comparison(rr, [final_same])
        assert len(out) == 1
        assert out[0]["retrieval_id"] == "g-tbl"  # prepended resolved wins

    def test_no_grounding_matches_plain_builder(self):
        finals = [
            _result(ElementType.TABLE, "t1", "tbl-1", 0.9,
                    {"table_headers": ["a"], "table_rows": [["1"]], "table_summary": "s"}, "x")
        ]
        rr = SimpleNamespace(structured_comparison=None, vision_analysis=None)
        assert handler._table_results_with_comparison(rr, finals) == handler._build_table_results(finals)


class TestImageResponsePartsGrounding:
    """A grounded image is unioned into image_results (mode-agnostic vision path)."""

    def test_grounded_image_surfaced_and_wire_derived(self):
        db_img = _result(
            ElementType.IMAGE, "g-img", "p", 1.0,
            {"provenance_page_num": 4}, "A map", "s3://b/fig4.png",
        )
        rr = _grounding_reasoning_result(resolved_image=db_img)
        wire, image_results = handler._image_response_parts(rr, [])
        assert [r["retrieval_id"] for r in image_results] == ["g-img"]
        assert wire == [{"image_s3_key": "s3://b/fig4.png", "analysis": "", "confidence": 0.9}]


class TestReasoningEngineTableResolverWired:
    """The retrieval handler must inject a table_resolver so grounding can resolve
    a numbered table reference (not only the top-retrieved fallback)."""

    def test_table_resolver_injected(self):
        assert handler._reasoning_engine.table_resolver is not None
