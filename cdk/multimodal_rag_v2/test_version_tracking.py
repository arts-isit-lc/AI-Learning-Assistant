"""Cross-layer version tracking verification tests.

Validates Requirements 11.1, 11.2, 11.3, 11.4:
- DocumentIR always has non-empty ir_version (set from build-time constant)
- Every EnrichedElement has non-empty enrichment_version
- Every RetrievalUnit has non-empty embedding_version in pgvector metadata
- Single processing run applies same enrichment_version and embedding_version
  to all artifacts from one document
"""

from __future__ import annotations

import pytest

from .models.data_models import (
    DocumentIR,
    EMBEDDING_VERSION,
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    FileMetadata,
    IR_VERSION,
    IRElement,
    Provenance,
    RawElement,
    RetrievalUnit,
)
from .enrichment.element_router import ElementRouter
from .enrichment.retrieval_unit_builder import RetrievalUnitBuilder
from .ingestion.ir_builder import IRBuilder


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_file_metadata() -> FileMetadata:
    return FileMetadata(
        course_id="CS101",
        module_id="module1",
        file_id="lecture.pdf",
        file_key="courses/CS101/module1/lecture.pdf",
        file_size=1024,
        extension=".pdf",
    )


def _make_raw_element(
    content: str = "Test content",
    element_type: ElementType = ElementType.TEXT,
    page_num: int = 1,
    position_index: int = 0,
) -> RawElement:
    return RawElement(
        content=content,
        element_type=element_type,
        provenance=Provenance(page_num=page_num, position_index=position_index),
    )


def _make_ir_element(
    element_id: str = "elem-001",
    content: str = "Test content",
    element_type: ElementType = ElementType.TEXT,
    page_num: int = 1,
) -> IRElement:
    return IRElement(
        element_id=element_id,
        content=content,
        element_type=element_type,
        provenance=Provenance(page_num=page_num, position_index=0),
        content_hash=f"hash-{element_id}",
    )


def _make_enriched_element(
    element_id: str = "elem-001",
    element_type: ElementType = ElementType.TEXT,
    embedding_text: str = "Enriched text content",
) -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=element_type,
        provenance=Provenance(page_num=1, position_index=0),
        embedding_text=embedding_text,
        enrichment_version=ENRICHMENT_VERSION,
    )


def _make_document_ir(elements: list[IRElement] | None = None) -> DocumentIR:
    if elements is None:
        elements = [_make_ir_element()]
    return DocumentIR(
        file_metadata=_make_file_metadata(),
        elements=elements,
    )


# ---------------------------------------------------------------------------
# Fake enrichment services for integration testing
# ---------------------------------------------------------------------------


class FakeTextChunker:
    """Minimal TextChunker that returns one EnrichedElement per IRElement."""

    def enrich(self, element: IRElement) -> list[EnrichedElement]:
        content = element.content if isinstance(element.content, str) else ""
        return [
            EnrichedElement(
                element_id=element.element_id,
                element_type=element.element_type,
                provenance=element.provenance,
                embedding_text=content or "text chunk",
                enrichment_version="",  # Router will override
            )
        ]


class FakeVisionService:
    """Minimal VisionService that returns an EnrichedElement for images."""

    def enrich(self, element: IRElement) -> EnrichedElement:
        return EnrichedElement(
            element_id=element.element_id,
            element_type=element.element_type,
            provenance=element.provenance,
            embedding_text="A diagram showing process flow",
            image_description="A diagram showing process flow",
            topics=["diagrams"],
            labels=["flow"],
            keywords=["process"],
            enrichment_version="",  # Router will override
        )


class FakeFormulaService:
    """Minimal FormulaService that returns an EnrichedElement for formulas."""

    def enrich(self, element: IRElement) -> EnrichedElement:
        content = element.content if isinstance(element.content, str) else "E=mc^2"
        return EnrichedElement(
            element_id=element.element_id,
            element_type=element.element_type,
            provenance=element.provenance,
            embedding_text=content,
            formula_text=content,
            latex_repr=content,
            formula_concepts=["energy"],
            enrichment_version="",  # Router will override
        )


class FakeTableService:
    """Minimal TableService that returns an EnrichedElement for tables."""

    def enrich(self, element: IRElement) -> EnrichedElement:
        return EnrichedElement(
            element_id=element.element_id,
            element_type=element.element_type,
            provenance=element.provenance,
            embedding_text="Table with grades data",
            table_headers=["Name", "Grade"],
            table_rows=[["Alice", "A"], ["Bob", "B"]],
            table_summary="Student grades table with 2 columns.",
            enrichment_version="",  # Router will override
        )


# ---------------------------------------------------------------------------
# Requirement 11.1: DocumentIR always has non-empty ir_version
# ---------------------------------------------------------------------------


class TestIRVersionTracking:
    """Requirement 11.1: DocumentIR always has non-empty ir_version."""

    def test_ir_version_constant_is_non_empty(self) -> None:
        """The IR_VERSION build-time constant itself is non-empty."""
        assert IR_VERSION != ""
        assert IR_VERSION.strip() != ""

    def test_document_ir_default_has_ir_version(self) -> None:
        """DocumentIR created with defaults gets IR_VERSION."""
        doc = DocumentIR(
            file_metadata=_make_file_metadata(),
            elements=[],
        )
        assert doc.ir_version == IR_VERSION
        assert doc.ir_version != ""

    def test_ir_builder_sets_ir_version(self) -> None:
        """IRBuilder.build() always produces DocumentIR with non-empty ir_version."""
        builder = IRBuilder()
        raw = [_make_raw_element("Content A"), _make_raw_element("Content B", page_num=2)]
        result = builder.build(raw, _make_file_metadata())

        assert result.ir_version == IR_VERSION
        assert result.ir_version != ""

    def test_ir_builder_empty_doc_has_ir_version(self) -> None:
        """Even an empty DocumentIR (zero elements) has non-empty ir_version."""
        builder = IRBuilder()
        result = builder.build([], _make_file_metadata())

        assert result.ir_version == IR_VERSION
        assert result.ir_version != ""


# ---------------------------------------------------------------------------
# Requirement 11.2: Every EnrichedElement has non-empty enrichment_version
# ---------------------------------------------------------------------------


class TestEnrichmentVersionTracking:
    """Requirement 11.2: Every EnrichedElement has non-empty enrichment_version."""

    def test_enrichment_version_constant_is_non_empty(self) -> None:
        """The ENRICHMENT_VERSION build-time constant itself is non-empty."""
        assert ENRICHMENT_VERSION != ""
        assert ENRICHMENT_VERSION.strip() != ""

    def test_router_tags_text_elements(self) -> None:
        """TEXT elements get enrichment_version from ElementRouter."""
        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FakeVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("t1", "Hello world", ElementType.TEXT),
        ])

        results = router.enrich_document(doc)
        for enriched in results:
            assert enriched.enrichment_version == ENRICHMENT_VERSION
            assert enriched.enrichment_version != ""

    def test_router_tags_image_elements(self) -> None:
        """IMAGE elements get enrichment_version from ElementRouter."""
        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FakeVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("img1", "image data", ElementType.IMAGE),
        ])

        results = router.enrich_document(doc)
        for enriched in results:
            assert enriched.enrichment_version == ENRICHMENT_VERSION
            assert enriched.enrichment_version != ""

    def test_router_tags_table_elements(self) -> None:
        """TABLE elements get enrichment_version from ElementRouter."""
        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FakeVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("tbl1", "table data", ElementType.TABLE),
        ])

        results = router.enrich_document(doc)
        for enriched in results:
            assert enriched.enrichment_version == ENRICHMENT_VERSION
            assert enriched.enrichment_version != ""

    def test_router_tags_formula_elements(self) -> None:
        """FORMULA elements get enrichment_version from ElementRouter."""
        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FakeVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("f1", "E=mc^2", ElementType.FORMULA),
        ])

        results = router.enrich_document(doc)
        for enriched in results:
            assert enriched.enrichment_version == ENRICHMENT_VERSION
            assert enriched.enrichment_version != ""

    def test_fallback_elements_have_enrichment_version(self) -> None:
        """Fallback EnrichedElements (on service failure) also get enrichment_version."""

        class FailingVisionService:
            def enrich(self, element: IRElement) -> EnrichedElement:
                raise RuntimeError("Vision service down")

        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FailingVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("img-fail", "binary data", ElementType.IMAGE),
        ])

        results = router.enrich_document(doc)
        assert len(results) == 1
        assert results[0].enrichment_version == ENRICHMENT_VERSION
        assert results[0].enrichment_version != ""


# ---------------------------------------------------------------------------
# Requirement 11.3: Every RetrievalUnit has non-empty embedding_version
# ---------------------------------------------------------------------------


class TestEmbeddingVersionTracking:
    """Requirement 11.3: Every RetrievalUnit has non-empty embedding_version."""

    def test_embedding_version_constant_is_non_empty(self) -> None:
        """The EMBEDDING_VERSION build-time constant itself is non-empty."""
        assert EMBEDDING_VERSION != ""
        assert EMBEDDING_VERSION.strip() != ""

    def test_text_units_have_embedding_version(self) -> None:
        """TEXT RetrievalUnits always have non-empty embedding_version."""
        builder = RetrievalUnitBuilder()
        enriched = [_make_enriched_element("t1", ElementType.TEXT, "Hello world")]
        units = builder.build(enriched)

        assert len(units) > 0
        for unit in units:
            assert unit.embedding_version == EMBEDDING_VERSION
            assert unit.embedding_version != ""

    def test_table_units_have_embedding_version(self) -> None:
        """TABLE RetrievalUnits always have non-empty embedding_version."""
        builder = RetrievalUnitBuilder()
        enriched = [
            EnrichedElement(
                element_id="tbl1",
                element_type=ElementType.TABLE,
                provenance=Provenance(page_num=1, position_index=0),
                embedding_text="Table data",
                table_headers=["Col1", "Col2"],
                table_rows=[["a", "b"]],
                table_summary="A table with data.",
                enrichment_version=ENRICHMENT_VERSION,
            )
        ]
        units = builder.build(enriched)

        assert len(units) >= 2  # summary + at least 1 column
        for unit in units:
            assert unit.embedding_version == EMBEDDING_VERSION
            assert unit.embedding_version != ""

    def test_image_units_have_embedding_version(self) -> None:
        """IMAGE RetrievalUnits always have non-empty embedding_version."""
        builder = RetrievalUnitBuilder()
        enriched = [
            EnrichedElement(
                element_id="img1",
                element_type=ElementType.IMAGE,
                provenance=Provenance(page_num=1, position_index=0),
                embedding_text="A photo of a cat",
                image_description="A photo of a cat",
                enrichment_version=ENRICHMENT_VERSION,
            )
        ]
        units = builder.build(enriched)

        assert len(units) == 1
        assert units[0].embedding_version == EMBEDDING_VERSION
        assert units[0].embedding_version != ""

    def test_formula_units_have_embedding_version(self) -> None:
        """FORMULA RetrievalUnits always have non-empty embedding_version."""
        builder = RetrievalUnitBuilder()
        enriched = [
            EnrichedElement(
                element_id="f1",
                element_type=ElementType.FORMULA,
                provenance=Provenance(page_num=1, position_index=0),
                embedding_text="E equals m c squared",
                enrichment_version=ENRICHMENT_VERSION,
            )
        ]
        units = builder.build(enriched)

        assert len(units) == 1
        assert units[0].embedding_version == EMBEDDING_VERSION
        assert units[0].embedding_version != ""


# ---------------------------------------------------------------------------
# Requirement 11.4: Same version across all artifacts from one document
# ---------------------------------------------------------------------------


class TestSingleDocumentVersionConsistency:
    """Requirement 11.4: Single processing run applies same versions to all artifacts."""

    def test_all_enriched_elements_same_enrichment_version(self) -> None:
        """All EnrichedElements from one document have the same enrichment_version."""
        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FakeVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("t1", "Text content", ElementType.TEXT, page_num=1),
            _make_ir_element("img1", "Image data", ElementType.IMAGE, page_num=2),
            _make_ir_element("f1", "E=mc^2", ElementType.FORMULA, page_num=3),
            _make_ir_element("tbl1", "Table data", ElementType.TABLE, page_num=4),
        ])

        results = router.enrich_document(doc)

        # All must have the same enrichment_version
        versions = {r.enrichment_version for r in results}
        assert len(versions) == 1, f"Expected 1 unique enrichment_version, got: {versions}"
        assert versions.pop() == ENRICHMENT_VERSION

    def test_all_retrieval_units_same_embedding_version(self) -> None:
        """All RetrievalUnits built from one document have the same embedding_version."""
        builder = RetrievalUnitBuilder()
        enriched = [
            _make_enriched_element("t1", ElementType.TEXT, "Text content chunk 1"),
            _make_enriched_element("t2", ElementType.TEXT, "Text content chunk 2"),
            EnrichedElement(
                element_id="img1",
                element_type=ElementType.IMAGE,
                provenance=Provenance(page_num=2, position_index=0),
                embedding_text="Diagram of cell structure",
                image_description="Diagram of cell structure",
                enrichment_version=ENRICHMENT_VERSION,
            ),
            EnrichedElement(
                element_id="tbl1",
                element_type=ElementType.TABLE,
                provenance=Provenance(page_num=3, position_index=0),
                embedding_text="Grades table",
                table_headers=["Name", "Grade"],
                table_rows=[["Alice", "A"]],
                table_summary="A grades table.",
                enrichment_version=ENRICHMENT_VERSION,
            ),
            EnrichedElement(
                element_id="f1",
                element_type=ElementType.FORMULA,
                provenance=Provenance(page_num=4, position_index=0),
                embedding_text="E equals m c squared",
                enrichment_version=ENRICHMENT_VERSION,
            ),
        ]

        units = builder.build(enriched)

        # All units must share the same embedding_version
        versions = {u.embedding_version for u in units}
        assert len(versions) == 1, f"Expected 1 unique embedding_version, got: {versions}"
        assert versions.pop() == EMBEDDING_VERSION

    def test_mixed_success_and_fallback_same_enrichment_version(self) -> None:
        """Even when some enrichments fail (fallback), all get the same enrichment_version."""

        class PartiallyFailingVision:
            def __init__(self) -> None:
                self._call_count = 0

            def enrich(self, element: IRElement) -> EnrichedElement:
                self._call_count += 1
                if self._call_count % 2 == 0:
                    raise RuntimeError("Intermittent failure")
                return EnrichedElement(
                    element_id=element.element_id,
                    element_type=element.element_type,
                    provenance=element.provenance,
                    embedding_text="Image description",
                    enrichment_version="",
                )

        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=PartiallyFailingVision(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        doc = _make_document_ir([
            _make_ir_element("t1", "Text", ElementType.TEXT, page_num=1),
            _make_ir_element("img1", "Img1", ElementType.IMAGE, page_num=2),
            _make_ir_element("img2", "Img2", ElementType.IMAGE, page_num=3),
            _make_ir_element("img3", "Img3", ElementType.IMAGE, page_num=4),
        ])

        results = router.enrich_document(doc)

        # All results (including fallbacks) must share the same enrichment_version
        versions = {r.enrichment_version for r in results}
        assert len(versions) == 1, f"Expected 1 unique enrichment_version, got: {versions}"
        assert versions.pop() == ENRICHMENT_VERSION


# ---------------------------------------------------------------------------
# End-to-end pipeline version tracking (Ingestion → Enrichment → RetrievalUnits)
# ---------------------------------------------------------------------------


class TestEndToEndVersionPipeline:
    """End-to-end version tracking from ingestion through retrieval unit creation."""

    def test_full_pipeline_version_tracking(self) -> None:
        """Simulate full pipeline: ingestion → enrichment → retrieval units.

        Verifies that ir_version, enrichment_version, and embedding_version
        are all correctly set at each stage.
        """
        # Stage 1: Ingestion — build DocumentIR
        ir_builder = IRBuilder()
        raw_elements = [
            _make_raw_element("Introduction to algorithms", ElementType.TEXT, page_num=1),
            _make_raw_element("Sorting comparison table", ElementType.TEXT, page_num=2),
        ]
        document_ir = ir_builder.build(raw_elements, _make_file_metadata())

        # Verify Stage 1: ir_version
        assert document_ir.ir_version == IR_VERSION
        assert document_ir.ir_version != ""

        # Stage 2: Enrichment — route elements
        router = ElementRouter(
            text_chunker=FakeTextChunker(),
            vision_service=FakeVisionService(),
            formula_service=FakeFormulaService(),
            table_service=FakeTableService(),
        )
        enriched_elements = router.enrich_document(document_ir)

        # Verify Stage 2: enrichment_version
        for enriched in enriched_elements:
            assert enriched.enrichment_version == ENRICHMENT_VERSION
            assert enriched.enrichment_version != ""

        # Stage 3: Build RetrievalUnits
        ru_builder = RetrievalUnitBuilder()
        retrieval_units = ru_builder.build(enriched_elements)

        # Verify Stage 3: embedding_version
        assert len(retrieval_units) > 0
        for unit in retrieval_units:
            assert unit.embedding_version == EMBEDDING_VERSION
            assert unit.embedding_version != ""
