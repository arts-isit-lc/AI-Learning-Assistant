"""Unit tests for ElementRouter — routing, fallback, backoff, visual cap, version tagging."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from ..models.data_models import (
    DocumentIR,
    ElementType,
    EnrichedElement,
    ENRICHMENT_VERSION,
    FileMetadata,
    IRElement,
    Provenance,
)
from .element_router import (
    ElementRouter,
    VISUAL_CAP,
    _create_fallback,
    _is_raster_formula,
    _is_throttling_error,
)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_element(
    element_type: ElementType = ElementType.TEXT,
    content: str | bytes = "sample text",
    element_id: str = "elem-001",
    page_num: int = 1,
) -> IRElement:
    return IRElement(
        element_id=element_id,
        content=content,
        element_type=element_type,
        provenance=Provenance(page_num=page_num, position_index=0),
        content_hash=f"hash-{element_id}",
    )


def _make_document_ir(elements: list[IRElement] | None = None) -> DocumentIR:
    if elements is None:
        elements = [_make_element()]
    return DocumentIR(
        file_metadata=FileMetadata(
            course_id="CS101",
            module_id="module1",
            file_id="file-001",
            file_key="courses/CS101/module1/lecture.pdf",
            file_size=1024,
            extension="pdf",
        ),
        elements=elements,
    )


def _make_enriched(element: IRElement) -> EnrichedElement:
    return EnrichedElement(
        element_id=element.element_id,
        element_type=element.element_type,
        provenance=element.provenance,
        embedding_text=f"enriched-{element.element_id}",
    )


class FakeTextChunker:
    """Fake TextChunker that returns a list of EnrichedElements."""

    def __init__(self, fail: bool = False) -> None:
        self._fail = fail
        self.call_count = 0

    def enrich(self, element: IRElement) -> list[EnrichedElement]:
        self.call_count += 1
        if self._fail:
            raise RuntimeError("TextChunker failed")
        return [_make_enriched(element)]


class FakeVisionService:
    """Fake VisionService that returns a single EnrichedElement."""

    def __init__(self, fail: bool = False, throttle_times: int = 0) -> None:
        self._fail = fail
        self._throttle_times = throttle_times
        self.call_count = 0

    def enrich(self, element: IRElement) -> EnrichedElement:
        self.call_count += 1
        if self._throttle_times > 0:
            self._throttle_times -= 1
            raise _make_throttling_error()
        if self._fail:
            raise RuntimeError("VisionService failed")
        return _make_enriched(element)


class FakeFormulaService:
    """Fake FormulaService."""

    def __init__(self, fail: bool = False) -> None:
        self._fail = fail
        self.call_count = 0

    def enrich(self, element: IRElement) -> EnrichedElement:
        self.call_count += 1
        if self._fail:
            raise RuntimeError("FormulaService failed")
        return _make_enriched(element)


class FakeTableService:
    """Fake TableService."""

    def __init__(self, fail: bool = False) -> None:
        self._fail = fail
        self.call_count = 0

    def enrich(self, element: IRElement) -> EnrichedElement:
        self.call_count += 1
        if self._fail:
            raise RuntimeError("TableService failed")
        return _make_enriched(element)


def _make_throttling_error() -> Exception:
    """Create a fake ThrottlingException-like error."""

    class ThrottlingException(Exception):
        pass

    return ThrottlingException("Rate exceeded")


def _make_client_error_429() -> Exception:
    """Create a fake ClientError with HTTP 429."""

    class ClientError(Exception):
        def __init__(self) -> None:
            super().__init__("Throttled")
            self.response = {
                "Error": {"Code": "ThrottlingException"},
                "ResponseMetadata": {"HTTPStatusCode": 429},
            }

    return ClientError()


def _make_router(
    text_chunker: FakeTextChunker | None = None,
    vision_service: FakeVisionService | None = None,
    formula_service: FakeFormulaService | None = None,
    table_service: FakeTableService | None = None,
) -> ElementRouter:
    return ElementRouter(
        text_chunker=text_chunker or FakeTextChunker(),
        vision_service=vision_service or FakeVisionService(),
        formula_service=formula_service or FakeFormulaService(),
        table_service=table_service or FakeTableService(),
    )


# ---------------------------------------------------------------------------
# Tests for routing dispatch (Requirement 3.1)
# ---------------------------------------------------------------------------


class TestRouting:
    def test_text_element_routes_to_text_chunker(self) -> None:
        chunker = FakeTextChunker()
        router = _make_router(text_chunker=chunker)
        doc = _make_document_ir([_make_element(ElementType.TEXT)])
        router.enrich_document(doc)
        assert chunker.call_count == 1

    def test_image_element_routes_to_vision_service(self) -> None:
        vision = FakeVisionService()
        router = _make_router(vision_service=vision)
        doc = _make_document_ir([_make_element(ElementType.IMAGE, content=b"\x89PNG")])
        router.enrich_document(doc)
        assert vision.call_count == 1

    def test_formula_element_routes_to_formula_service(self) -> None:
        formula = FakeFormulaService()
        router = _make_router(formula_service=formula)
        doc = _make_document_ir([_make_element(ElementType.FORMULA, content="E=mc^2")])
        router.enrich_document(doc)
        assert formula.call_count == 1

    def test_table_element_routes_to_table_service(self) -> None:
        table = FakeTableService()
        router = _make_router(table_service=table)
        doc = _make_document_ir([_make_element(ElementType.TABLE, content="col1,col2")])
        router.enrich_document(doc)
        assert table.call_count == 1

    def test_all_elements_processed(self) -> None:
        elements = [
            _make_element(ElementType.TEXT, element_id="t1"),
            _make_element(ElementType.IMAGE, content=b"\x89PNG", element_id="i1"),
            _make_element(ElementType.FORMULA, content="x=1", element_id="f1"),
            _make_element(ElementType.TABLE, content="a,b", element_id="tb1"),
        ]
        router = _make_router()
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        assert len(result) == 4


# ---------------------------------------------------------------------------
# Tests for fallback logic (Requirement 3.6)
# ---------------------------------------------------------------------------


class TestFallback:
    def test_text_failure_produces_fallback(self) -> None:
        chunker = FakeTextChunker(fail=True)
        router = _make_router(text_chunker=chunker)
        element = _make_element(ElementType.TEXT, content="hello")
        doc = _make_document_ir([element])
        result = router.enrich_document(doc)
        assert len(result) == 1
        assert result[0].embedding_text == "hello"
        assert result[0].enrichment_version == ENRICHMENT_VERSION

    def test_image_failure_produces_fallback_empty_text(self) -> None:
        vision = FakeVisionService(fail=True)
        router = _make_router(vision_service=vision)
        element = _make_element(ElementType.IMAGE, content=b"\x89PNG")
        doc = _make_document_ir([element])
        result = router.enrich_document(doc)
        assert len(result) == 1
        assert result[0].embedding_text == ""

    def test_failure_does_not_affect_other_elements(self) -> None:
        """Requirement 3.6: failed element gets fallback, others unaffected."""
        # Vision fails, but text should succeed
        vision = FakeVisionService(fail=True)
        chunker = FakeTextChunker()
        router = _make_router(text_chunker=chunker, vision_service=vision)
        elements = [
            _make_element(ElementType.TEXT, element_id="t1"),
            _make_element(ElementType.IMAGE, content=b"img", element_id="i1"),
            _make_element(ElementType.TEXT, element_id="t2"),
        ]
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        assert len(result) == 3
        # Text elements enriched normally
        assert result[0].embedding_text == "enriched-t1"
        assert result[2].embedding_text == "enriched-t2"
        # Image got fallback
        assert result[1].embedding_text == ""


# ---------------------------------------------------------------------------
# Tests for exponential backoff (Requirement 3.7)
# ---------------------------------------------------------------------------


class TestExponentialBackoff:
    @patch("multimodal_rag_v2.enrichment.element_router.time.sleep")
    def test_retries_on_throttling_then_succeeds(self, mock_sleep) -> None:
        """Throttle twice, then succeed on third attempt."""
        vision = FakeVisionService(throttle_times=2)
        router = _make_router(vision_service=vision)
        element = _make_element(ElementType.IMAGE, content=b"img")
        doc = _make_document_ir([element])
        result = router.enrich_document(doc)
        # Should succeed after retries
        assert result[0].embedding_text == "enriched-elem-001"
        # Verify backoff delays: 1s, 2s
        assert mock_sleep.call_count == 2
        assert mock_sleep.call_args_list[0][0][0] == 1.0
        assert mock_sleep.call_args_list[1][0][0] == 2.0

    @patch("multimodal_rag_v2.enrichment.element_router.time.sleep")
    def test_max_retries_exhausted_produces_fallback(self, mock_sleep) -> None:
        """Throttle more times than max retries → fallback."""
        vision = FakeVisionService(throttle_times=10)
        router = _make_router(vision_service=vision)
        element = _make_element(ElementType.IMAGE, content=b"img")
        doc = _make_document_ir([element])
        result = router.enrich_document(doc)
        # Should get fallback (empty for binary)
        assert result[0].embedding_text == ""
        # 3 retries: sleeps at attempt 0, 1, 2 — then fails at attempt 3
        assert mock_sleep.call_count == 3

    @patch("multimodal_rag_v2.enrichment.element_router.time.sleep")
    def test_non_throttling_error_no_retry(self, mock_sleep) -> None:
        """Non-throttling errors should not trigger retries."""
        vision = FakeVisionService(fail=True)
        router = _make_router(vision_service=vision)
        element = _make_element(ElementType.IMAGE, content=b"img")
        doc = _make_document_ir([element])
        result = router.enrich_document(doc)
        assert result[0].embedding_text == ""
        assert mock_sleep.call_count == 0


# ---------------------------------------------------------------------------
# Tests for visual cap enforcement (Requirement 3.8)
# ---------------------------------------------------------------------------


class TestVisualCap:
    def test_cap_enforced_at_30(self) -> None:
        """After 30 vision calls, remaining visual elements get fallback."""
        vision = FakeVisionService()
        router = _make_router(vision_service=vision)
        # Create 35 image elements
        elements = [
            _make_element(ElementType.IMAGE, content=b"img", element_id=f"img-{i}")
            for i in range(35)
        ]
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        assert len(result) == 35
        # First 30 enriched normally
        assert vision.call_count == VISUAL_CAP
        for r in result[:VISUAL_CAP]:
            assert r.embedding_text.startswith("enriched-")
        # Remaining 5 got fallback (empty for binary)
        for r in result[VISUAL_CAP:]:
            assert r.embedding_text == ""

    def test_raster_formula_counts_toward_cap(self) -> None:
        """Raster formula elements (bytes content) count toward the visual cap."""
        vision = FakeVisionService()
        formula = FakeFormulaService()
        router = _make_router(vision_service=vision, formula_service=formula)
        elements: list[IRElement] = []
        # 29 images + 1 raster formula = cap reached
        for i in range(29):
            elements.append(
                _make_element(ElementType.IMAGE, content=b"img", element_id=f"img-{i}")
            )
        elements.append(
            _make_element(ElementType.FORMULA, content=b"raster", element_id="raster-f1")
        )
        # One more image after cap
        elements.append(
            _make_element(ElementType.IMAGE, content=b"img", element_id="img-30")
        )
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        assert len(result) == 31
        # Last image should be fallback
        assert result[-1].embedding_text == ""

    def test_text_formula_does_not_count_toward_cap(self) -> None:
        """Text-layer formula (str content) does NOT count toward visual cap."""
        formula = FakeFormulaService()
        vision = FakeVisionService()
        router = _make_router(vision_service=vision, formula_service=formula)
        elements = [
            _make_element(ElementType.FORMULA, content="E=mc^2", element_id="f1"),
        ]
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        assert formula.call_count == 1
        # Text-layer formula goes through formula service, not counted as vision
        assert result[0].embedding_text == "enriched-f1"

    def test_text_elements_not_affected_by_cap(self) -> None:
        """TEXT elements never use vision, so they're unaffected by the cap."""
        chunker = FakeTextChunker()
        vision = FakeVisionService()
        router = _make_router(text_chunker=chunker, vision_service=vision)
        # 30 images (fills cap) + 5 text elements
        elements = [
            _make_element(ElementType.IMAGE, content=b"img", element_id=f"img-{i}")
            for i in range(30)
        ]
        elements.extend(
            _make_element(ElementType.TEXT, content="text", element_id=f"txt-{i}")
            for i in range(5)
        )
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        # All text elements should be enriched normally
        text_results = [r for r in result if r.element_type == ElementType.TEXT]
        assert len(text_results) == 5
        for r in text_results:
            assert r.embedding_text.startswith("enriched-")


# ---------------------------------------------------------------------------
# Tests for enrichment_version tagging (Requirement 3.9)
# ---------------------------------------------------------------------------


class TestVersionTagging:
    def test_all_results_tagged_with_enrichment_version(self) -> None:
        router = _make_router()
        elements = [
            _make_element(ElementType.TEXT, element_id="t1"),
            _make_element(ElementType.IMAGE, content=b"img", element_id="i1"),
            _make_element(ElementType.FORMULA, content="x=1", element_id="f1"),
            _make_element(ElementType.TABLE, content="a,b", element_id="tb1"),
        ]
        doc = _make_document_ir(elements)
        result = router.enrich_document(doc)
        for r in result:
            assert r.enrichment_version == ENRICHMENT_VERSION

    def test_fallback_elements_also_tagged(self) -> None:
        vision = FakeVisionService(fail=True)
        router = _make_router(vision_service=vision)
        element = _make_element(ElementType.IMAGE, content=b"img")
        doc = _make_document_ir([element])
        result = router.enrich_document(doc)
        assert result[0].enrichment_version == ENRICHMENT_VERSION


# ---------------------------------------------------------------------------
# Tests for helper functions
# ---------------------------------------------------------------------------


class TestHelpers:
    def test_is_throttling_error_with_throttling_exception(self) -> None:
        assert _is_throttling_error(_make_throttling_error()) is True

    def test_is_throttling_error_with_client_error_429(self) -> None:
        assert _is_throttling_error(_make_client_error_429()) is True

    def test_is_throttling_error_with_generic_error(self) -> None:
        assert _is_throttling_error(RuntimeError("generic")) is False

    def test_create_fallback_with_text_content(self) -> None:
        elem = _make_element(content="hello world")
        fallback = _create_fallback(elem)
        assert fallback.embedding_text == "hello world"
        assert fallback.element_type == ElementType.TEXT
        assert fallback.enrichment_version == ENRICHMENT_VERSION

    def test_create_fallback_with_binary_content(self) -> None:
        elem = _make_element(content=b"\x89PNG")
        fallback = _create_fallback(elem)
        assert fallback.embedding_text == ""

    def test_is_raster_formula_with_bytes(self) -> None:
        elem = _make_element(ElementType.FORMULA, content=b"raster data")
        assert _is_raster_formula(elem) is True

    def test_is_raster_formula_with_text(self) -> None:
        elem = _make_element(ElementType.FORMULA, content="E=mc^2")
        assert _is_raster_formula(elem) is False

    def test_is_raster_formula_with_non_formula(self) -> None:
        elem = _make_element(ElementType.IMAGE, content=b"img")
        assert _is_raster_formula(elem) is False
