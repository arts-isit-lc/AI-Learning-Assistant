"""Tests for ImageEscalation — sibling lookup, S3 URI parsing, fallback logic.

Validates:
- _fetch_image correctly parses s3://bucket/key URI format
- _fetch_image handles plain key format (no s3:// prefix)
- _find_sibling_linked_images returns sibling images when figure_reference matches
- _find_sibling_linked_images returns empty when no match
- _find_sibling_linked_images falls back to same-page images
- escalate() prefers sibling-linked images over top-scoring unrelated images
- escalate() falls back to score-based when no sibling match
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch
from io import BytesIO
import json

import pytest

from ..models.data_models import (
    ElementType,
    FigureReference,
    ImageAnalysis,
    QueryIntent,
    RankedResult,
)
from .image_escalation import EscalationResult, ImageEscalation


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_ranked_result(
    retrieval_id: str = "result-1",
    element_type: ElementType = ElementType.TEXT,
    score: float = 0.8,
    image_s3_key: str | None = None,
    figure_ref: str = "",
    sibling_ids: list[str] | None = None,
    page_num: int = 1,
) -> RankedResult:
    metadata = {"provenance_page_num": page_num}
    if figure_ref:
        metadata["figure_ref"] = figure_ref
    return RankedResult(
        retrieval_id=retrieval_id,
        parent_element_id=f"parent-{retrieval_id}",
        content=f"Content for {retrieval_id}",
        element_type=element_type,
        score=score,
        cross_encoder_score=0.0,
        metadata_boost=0.0,
        metadata=metadata,
        image_s3_key=image_s3_key,
        sibling_ids=sibling_ids or [],
    )


def _make_escalation(
    bucket_name: str = "test-bucket",
) -> ImageEscalation:
    """Create an ImageEscalation with mock S3 and Bedrock clients."""
    s3_client = MagicMock()
    s3_client.get_object.return_value = {
        "Body": BytesIO(b"fake-png-bytes"),
    }

    bedrock_client = MagicMock()
    response_body = {
        "content": [{"text": "The image shows a graph with red and blue lines."}],
        "stop_reason": "end_turn",
    }
    bedrock_client.invoke_model.return_value = {
        "body": BytesIO(json.dumps(response_body).encode()),
    }

    return ImageEscalation(
        s3_client=s3_client,
        bedrock_client=bedrock_client,
        bucket_name=bucket_name,
    )


# ---------------------------------------------------------------------------
# Tests: S3 URI Parsing in _fetch_image
# ---------------------------------------------------------------------------


class TestFetchImageURIParsing:
    """_fetch_image correctly handles both s3:// URIs and plain keys."""

    def test_parses_full_s3_uri(self) -> None:
        escalation = _make_escalation()
        result = escalation._fetch_image("s3://my-bucket/images/course/module/abc.png")

        escalation.s3_client.get_object.assert_called_once_with(
            Bucket="my-bucket",
            Key="images/course/module/abc.png",
        )
        assert result == b"fake-png-bytes"

    def test_uses_bucket_name_for_plain_key(self) -> None:
        escalation = _make_escalation(bucket_name="default-bucket")
        result = escalation._fetch_image("images/course/module/abc.png")

        escalation.s3_client.get_object.assert_called_once_with(
            Bucket="default-bucket",
            Key="images/course/module/abc.png",
        )
        assert result == b"fake-png-bytes"

    def test_returns_none_on_s3_error(self) -> None:
        escalation = _make_escalation()
        escalation.s3_client.get_object.side_effect = Exception("NoSuchKey")

        result = escalation._fetch_image("s3://bucket/missing.png")

        assert result is None

    def test_handles_s3_uri_with_deep_path(self) -> None:
        escalation = _make_escalation()
        uri = "s3://aila-multimodalragstack-ir-bucket/images/course-id/module-id/abc123.png"
        escalation._fetch_image(uri)

        escalation.s3_client.get_object.assert_called_once_with(
            Bucket="aila-multimodalragstack-ir-bucket",
            Key="images/course-id/module-id/abc123.png",
        )


# ---------------------------------------------------------------------------
# Tests: _find_sibling_linked_images
# ---------------------------------------------------------------------------


class TestFindSiblingLinkedImages:
    """Finds images linked to caption text via sibling_ids."""

    def test_finds_sibling_image_via_figure_ref(self) -> None:
        escalation = _make_escalation()
        caption = _make_ranked_result(
            retrieval_id="text-1",
            element_type=ElementType.TEXT,
            figure_ref="figure 1.1",
            sibling_ids=["img-1"],
        )
        image = _make_ranked_result(
            retrieval_id="img-1",
            element_type=ElementType.IMAGE,
            image_s3_key="s3://bucket/img.png",
        )
        results = [caption, image]

        found = escalation._find_sibling_linked_images(results, "1.1")

        assert len(found) == 1
        assert found[0].retrieval_id == "img-1"

    def test_returns_empty_when_no_figure_ref_matches(self) -> None:
        escalation = _make_escalation()
        caption = _make_ranked_result(
            retrieval_id="text-1",
            element_type=ElementType.TEXT,
            figure_ref="figure 2.1",
            sibling_ids=["img-1"],
        )
        image = _make_ranked_result(
            retrieval_id="img-1",
            element_type=ElementType.IMAGE,
            image_s3_key="s3://bucket/img.png",
        )
        results = [caption, image]

        found = escalation._find_sibling_linked_images(results, "1.1")

        # "1.1" not in "figure 2.1"
        assert len(found) == 0

    def test_returns_empty_when_no_text_results_have_figure_ref(self) -> None:
        escalation = _make_escalation()
        text = _make_ranked_result(
            retrieval_id="text-1",
            element_type=ElementType.TEXT,
            figure_ref="",
        )
        results = [text]

        found = escalation._find_sibling_linked_images(results, "1.1")

        assert len(found) == 0

    def test_falls_back_to_same_page_image(self) -> None:
        """When sibling image isn't in results, find image on same page."""
        escalation = _make_escalation()
        caption = _make_ranked_result(
            retrieval_id="text-1",
            element_type=ElementType.TEXT,
            figure_ref="figure 1.1",
            sibling_ids=["img-not-in-results"],  # Sibling not in results
            page_num=3,
        )
        # Image on same page but different retrieval_id
        page_image = _make_ranked_result(
            retrieval_id="img-page-3",
            element_type=ElementType.IMAGE,
            image_s3_key="s3://bucket/page3.png",
            page_num=3,
        )
        results = [caption, page_image]

        found = escalation._find_sibling_linked_images(results, "1.1")

        # Should find the page image as fallback
        assert len(found) >= 1


# ---------------------------------------------------------------------------
# Tests: escalate() method
# ---------------------------------------------------------------------------


class TestEscalateMethod:
    """Full escalation flow."""

    def test_escalation_with_sibling_image_succeeds(self) -> None:
        escalation = _make_escalation()
        caption = _make_ranked_result(
            retrieval_id="text-1",
            element_type=ElementType.TEXT,
            figure_ref="figure 1.1",
            sibling_ids=["img-1"],
        )
        image = _make_ranked_result(
            retrieval_id="img-1",
            element_type=ElementType.IMAGE,
            image_s3_key="s3://bucket/img.png",
        )
        results = [caption, image]
        query_intent = QueryIntent(
            requires_image=True,
            requires_escalation=True,
            figure_reference=FigureReference(ref_type="figure", number="1.1"),
        )

        result = escalation.escalate(results, "What colours in Figure 1.1?", query_intent=query_intent)

        assert result.escalation_used is True
        assert len(result.image_analyses) == 1
        assert "red" in result.image_analyses[0].analysis.lower() or "graph" in result.image_analyses[0].analysis.lower()

    def test_escalation_falls_back_to_score_based_when_no_sibling(self) -> None:
        escalation = _make_escalation()
        image = _make_ranked_result(
            retrieval_id="img-1",
            element_type=ElementType.IMAGE,
            score=0.9,
            image_s3_key="s3://bucket/img.png",
        )
        results = [image]
        # No figure_reference — uses score-based selection
        query_intent = QueryIntent(requires_image=True)

        result = escalation.escalate(results, "Show me a diagram", query_intent=query_intent)

        assert result.escalation_used is True
        assert len(result.image_analyses) == 1

    def test_escalation_returns_false_when_no_images(self) -> None:
        escalation = _make_escalation()
        text = _make_ranked_result(
            retrieval_id="text-1",
            element_type=ElementType.TEXT,
        )
        results = [text]

        result = escalation.escalate(results, "What is in the figure?")

        assert result.escalation_used is False
        assert result.image_analyses == []

    def test_escalation_handles_s3_failure_gracefully(self) -> None:
        escalation = _make_escalation()
        escalation.s3_client.get_object.side_effect = Exception("Access denied")

        image = _make_ranked_result(
            retrieval_id="img-1",
            element_type=ElementType.IMAGE,
            image_s3_key="s3://bucket/img.png",
        )
        results = [image]

        result = escalation.escalate(results, "Show me the figure")

        assert result.escalation_used is False

    def test_escalation_handles_bedrock_failure_gracefully(self) -> None:
        escalation = _make_escalation()
        escalation.bedrock_client.invoke_model.side_effect = Exception("Throttled")

        image = _make_ranked_result(
            retrieval_id="img-1",
            element_type=ElementType.IMAGE,
            image_s3_key="s3://bucket/img.png",
        )
        results = [image]

        result = escalation.escalate(results, "Show me the figure")

        assert result.escalation_used is False

    def test_escalation_selects_top_2_by_score(self) -> None:
        escalation = _make_escalation()
        img1 = _make_ranked_result("img-1", ElementType.IMAGE, score=0.9, image_s3_key="s3://b/1.png")
        img2 = _make_ranked_result("img-2", ElementType.IMAGE, score=0.7, image_s3_key="s3://b/2.png")
        img3 = _make_ranked_result("img-3", ElementType.IMAGE, score=0.5, image_s3_key="s3://b/3.png")
        results = [img1, img2, img3]

        result = escalation.escalate(results, "Describe the images")

        # Should analyze at most 2 images
        assert result.escalation_used is True
        assert len(result.image_analyses) <= 2


# ---------------------------------------------------------------------------
# Tests: file/module scope on the direct DB figure lookup
#
# Regression guard for cross-module-file-referencing: the escalation DB
# lookups used to query the whole retrieval_units table, so "Figure 4.1" could
# resolve to another course/file's figure, and the table page-render lookup
# (keyed by provenance_page_num, which collides across files) could return the
# wrong file's page image. escalate() now threads the same scope_filter the
# main search used down into these queries.
# ---------------------------------------------------------------------------


class _RecordingCursor:
    """Captures executed (sql, params); returns queued rows from fetchone()."""

    def __init__(self, rows: list) -> None:
        self._rows = list(rows)
        self.executed: list[tuple] = []

    def execute(self, sql: str, params=None) -> None:
        self.executed.append((sql, params))

    def fetchone(self):
        return self._rows.pop(0) if self._rows else None

    def close(self) -> None:
        pass


class _RecordingConn:
    def __init__(self, cursor: _RecordingCursor) -> None:
        self._cursor = cursor

    def cursor(self) -> _RecordingCursor:
        return self._cursor

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


def _escalation_with_db(rows: list):
    """ImageEscalation wired to a recording DB connection returning `rows`."""
    esc = _make_escalation()
    cursor = _RecordingCursor(rows)
    esc._db_connection_factory = lambda: _RecordingConn(cursor)
    return esc, cursor


class TestScopePredicate:
    """_scope_predicate renders the two promoted scope keys into SQL + params."""

    def test_file_id_list_uses_any(self) -> None:
        sql, params = ImageEscalation._scope_predicate({"file_id": ["f1", "f2"]})
        assert sql == " AND file_id = ANY(%s)"
        assert params == [["f1", "f2"]]

    def test_module_id_scalar_uses_equality(self) -> None:
        sql, params = ImageEscalation._scope_predicate({"module_id": "m1"})
        assert sql == " AND module_id = %s"
        assert params == ["m1"]

    def test_none_and_empty_are_noops(self) -> None:
        assert ImageEscalation._scope_predicate(None) == ("", [])
        assert ImageEscalation._scope_predicate({}) == ("", [])

    def test_ignores_non_scope_keys(self) -> None:
        # Only file_id/module_id are promoted columns; intent keys are ignored.
        assert ImageEscalation._scope_predicate({"lecture_number": 3}) == ("", [])


class TestDbLookupScoping:
    """_find_image_by_figure_ref_in_db restricts every lookup to the scope."""

    def test_file_id_scope_applied_to_direct_image_match(self) -> None:
        image_row = ("img-1", "figure 4.1 diagram", {"image_s3_key": "s3://b/i.png"})
        esc, cursor = _escalation_with_db([image_row])

        result = esc._find_image_by_figure_ref_in_db(
            "figure", "4.1", scope_filter={"file_id": ["file-A"]}
        )

        assert result is not None
        sql_a, params_a = cursor.executed[0]
        assert "file_id = ANY(%s)" in sql_a
        assert ["file-A"] in params_a

    def test_no_scope_leaves_query_unfiltered(self) -> None:
        image_row = ("img-1", "figure 4.1 diagram", {"image_s3_key": "s3://b/i.png"})
        esc, cursor = _escalation_with_db([image_row])

        esc._find_image_by_figure_ref_in_db("figure", "4.1", scope_filter=None)

        sql_a, _ = cursor.executed[0]
        assert "file_id = ANY" not in sql_a
        assert "module_id = %s" not in sql_a

    def test_table_page_render_image_lookup_is_scoped(self) -> None:
        # A miss -> B miss -> C: table found on page 5 -> same-page image lookup.
        # The page-image query MUST be scoped: page_num collides across files.
        rows = [
            None,  # Strategy A: no direct image embedding_text match
            None,  # Strategy B: no figure_ref caption
            ("5",),  # Strategy C: table located on page 5
            ("img-p5", "page 5 render", {"image_s3_key": "s3://b/p5.png"}),
        ]
        esc, cursor = _escalation_with_db(rows)

        result = esc._find_image_by_figure_ref_in_db(
            "table", "2.1", scope_filter={"file_id": ["file-A"]}
        )

        assert result is not None
        sql_img, params_img = cursor.executed[-1]
        assert "file_id = ANY(%s)" in sql_img
        assert ["file-A"] in params_img

    def test_escalate_threads_scope_into_db_lookup(self) -> None:
        # No sibling image in the ranked results forces escalate() down the
        # direct DB lookup path, which must carry the scope through.
        image_row = ("img-1", "figure 4.1 diagram", {"image_s3_key": "s3://b/i.png"})
        esc, cursor = _escalation_with_db([image_row])
        query_intent = QueryIntent(
            requires_image=True,
            figure_reference=FigureReference(ref_type="figure", number="4.1"),
        )

        result = esc.escalate(
            [],
            "can you explain figure 4.1 to me?",
            query_intent=query_intent,
            scope_filter={"file_id": ["file-A"]},
        )

        assert result.escalation_used is True
        assert any("file_id = ANY(%s)" in sql for sql, _ in cursor.executed)


# ---------------------------------------------------------------------------
# Tests: exact figure/table reference regex (M11)
#
# The direct DB lookup used to match embedding_text with a bare LIKE, so
# "figure 4" matched "figure 4.1 / 40 / 24" and returned the wrong image.
# _build_reference_regex anchors the number with non-digit/non-dot boundaries.
# Postgres uses `~*` (case-insensitive POSIX); these tests mirror that with
# Python re + IGNORECASE, which is equivalent for these boundary classes.
# ---------------------------------------------------------------------------


class TestReferenceRegex:
    """_build_reference_regex matches an exact figure/table number only."""

    @staticmethod
    def _matches(ref_type: str, number: str, text: str) -> bool:
        import re
        pattern = ImageEscalation._build_reference_regex(ref_type, number)
        return re.search(pattern, text, re.IGNORECASE) is not None

    def test_matches_exact_reference_mid_text(self) -> None:
        assert self._matches("figure", "4.1", "See Figure 4.1 for the layout")

    def test_matches_reference_at_start(self) -> None:
        assert self._matches("figure", "4.1", "Figure 4.1 shows the tree")

    def test_matches_reference_at_end(self) -> None:
        assert self._matches("figure", "4.1", "as shown in figure 4.1")

    def test_does_not_match_longer_number_suffix(self) -> None:
        # "figure 4.1" must NOT match "figure 4.10".
        assert not self._matches("figure", "4.1", "Figure 4.10 shows ...")

    def test_bare_integer_does_not_match_decimal(self) -> None:
        # "figure 4" must NOT match "figure 4.1".
        assert not self._matches("figure", "4", "Figure 4.1 shows ...")

    def test_does_not_match_longer_number_prefix(self) -> None:
        # "figure 1.1" must NOT match "figure 14.1".
        assert not self._matches("figure", "1.1", "Figure 14.1 is here")

    def test_matches_table_reference(self) -> None:
        assert self._matches("table", "2.3", "as shown in Table 2.3 above")

    def test_case_insensitive(self) -> None:
        assert self._matches("figure", "4.1", "FIGURE 4.1 (uppercase)")

    def test_no_match_when_reference_absent(self) -> None:
        assert not self._matches("figure", "4.1", "there is no such reference here")


# ---------------------------------------------------------------------------
# Parallel image analysis (latency fix): _analyze_images + ESCALATION_MAX_IMAGES
# ---------------------------------------------------------------------------


def _fake_analyze_factory(fail_ids=()):
    """Return an _analyze_image stand-in that echoes retrieval_id as the analysis
    (so order is assertable) and returns None for `fail_ids`."""
    def _fake(result, query):
        if result.retrieval_id in fail_ids:
            return None
        return ImageAnalysis(
            image_s3_key=result.image_s3_key or "",
            analysis=result.retrieval_id,
            confidence=0.9,
        )
    return _fake


def _imgs(*ids):
    return [
        _make_ranked_result(i, ElementType.IMAGE, image_s3_key=f"s3://b/{i}.png")
        for i in ids
    ]


class TestParallelAnalyzeImages:
    """The <=2 vision calls run concurrently, keep input order, drop failures."""

    def test_preserves_order_and_drops_failures(self) -> None:
        esc = _make_escalation()
        esc._analyze_image = _fake_analyze_factory(fail_ids={"b"})
        out = esc._analyze_images(_imgs("a", "b", "c"), "q")
        # b failed and is dropped; a and c keep their input order.
        assert [a.analysis for a in out] == ["a", "c"]

    def test_empty_returns_empty(self) -> None:
        esc = _make_escalation()
        assert esc._analyze_images([], "q") == []

    def test_single_image_no_executor_path(self) -> None:
        esc = _make_escalation()
        esc._analyze_image = _fake_analyze_factory()
        out = esc._analyze_images(_imgs("only"), "q")
        assert [a.analysis for a in out] == ["only"]

    def test_all_failures_returns_empty(self) -> None:
        esc = _make_escalation()
        esc._analyze_image = _fake_analyze_factory(fail_ids={"a", "b"})
        assert esc._analyze_images(_imgs("a", "b"), "q") == []

    def test_order_is_deterministic_across_runs(self) -> None:
        esc = _make_escalation()
        esc._analyze_image = _fake_analyze_factory()
        imgs = _imgs("a", "b", "c")
        first = [a.analysis for a in esc._analyze_images(imgs, "q")]
        assert first == ["a", "b", "c"]
        for _ in range(5):
            assert [a.analysis for a in esc._analyze_images(imgs, "q")] == first

    def test_max_images_cap_is_respected(self, monkeypatch) -> None:
        # With the cap at 1, a generic (no figure_reference) escalation analyzes
        # only the top-scoring image.
        from . import image_escalation as ie
        monkeypatch.setattr(ie, "_MAX_ESCALATION_IMAGES", 1)
        esc = _make_escalation()
        imgs = [
            _make_ranked_result(f"i{i}", ElementType.IMAGE, score=0.9 - i * 0.1,
                                 image_s3_key=f"s3://b/{i}.png")
            for i in range(3)
        ]
        result = esc.escalate(imgs, "describe the images")
        assert result.escalation_used is True
        assert len(result.image_analyses) == 1

    def test_default_cap_allows_two_images(self) -> None:
        # Default cap (2): a generic escalation analyzes the top 2 images.
        esc = _make_escalation()
        esc._analyze_image = _fake_analyze_factory()
        imgs = [
            _make_ranked_result(f"i{i}", ElementType.IMAGE, score=0.9 - i * 0.1,
                                 image_s3_key=f"s3://b/{i}.png")
            for i in range(3)
        ]
        result = esc.escalate(imgs, "describe the images")
        assert len(result.image_analyses) == 2
