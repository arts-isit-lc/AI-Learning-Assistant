"""Unit tests for RetrievalUnitBuilder — validates Requirements 4.1-4.8."""

from __future__ import annotations

import pytest

from ..models.data_models import (
    EMBEDDING_VERSION,
    ElementType,
    EnrichedElement,
    Provenance,
    RetrievalUnit,
)
from .retrieval_unit_builder import RetrievalUnitBuilder


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_text_element(
    element_id: str = "text-elem-1",
    embedding_text: str = "Some text content for embedding.",
    page_num: int = 1,
    position_index: int = 0,
) -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=page_num, position_index=position_index),
        embedding_text=embedding_text,
        topics=[],
        labels=[],
        keywords=[],
        file_id="file-1",
        course_id="course-1",
        module_id="module-1",
    )


def _make_table_element(
    element_id: str = "table-elem-1",
    table_summary: str = "A table showing student grades across courses.",
    table_headers: list[str] | None = None,
    table_rows: list[list[str]] | None = None,
    embedding_text: str = "Table content with grades.",
) -> EnrichedElement:
    if table_headers is None:
        table_headers = ["Name", "Grade", "Course"]
    if table_rows is None:
        table_rows = [
            ["Alice", "A", "Math"],
            ["Bob", "B+", "Science"],
            ["Carol", "A-", "History"],
        ]
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.TABLE,
        provenance=Provenance(page_num=2, position_index=0),
        embedding_text=embedding_text,
        table_headers=table_headers,
        table_rows=table_rows,
        table_summary=table_summary,
        file_id="file-1",
        course_id="course-1",
        module_id="module-1",
    )


def _make_image_element(
    element_id: str = "image-elem-1",
    embedding_text: str = "A diagram showing neural network architecture.",
    image_s3_key: str = "s3://bucket/images/nn_diagram.png",
    image_type: str = "diagram",
    image_description: str = "Neural network architecture diagram",
) -> EnrichedElement:
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.IMAGE,
        provenance=Provenance(page_num=3, position_index=1),
        embedding_text=embedding_text,
        image_s3_key=image_s3_key,
        image_type=image_type,
        image_description=image_description,
        topics=["neural networks", "deep learning"],
        file_id="file-1",
        course_id="course-1",
        module_id="module-1",
    )


def _make_formula_element(
    element_id: str = "formula-elem-1",
    embedding_text: str = "The ideal gas law states PV = nRT",
    latex_repr: str = "PV = nRT",
    formula_concepts: list[str] | None = None,
) -> EnrichedElement:
    if formula_concepts is None:
        formula_concepts = ["ideal gas law", "pressure", "volume"]
    return EnrichedElement(
        element_id=element_id,
        element_type=ElementType.FORMULA,
        provenance=Provenance(page_num=4, position_index=2),
        embedding_text=embedding_text,
        formula_text="PV equals nRT",
        latex_repr=latex_repr,
        formula_concepts=formula_concepts,
        file_id="file-1",
        course_id="course-1",
        module_id="module-1",
    )


# ---------------------------------------------------------------------------
# Tests for TABLE decomposition (Req 4.2)
# ---------------------------------------------------------------------------


class TestTableDecomposition:
    """Tests for TABLE → summary + column units."""

    def test_table_produces_summary_plus_column_units(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element()
        units = builder.build([table])

        # Minimum 2: 1 summary + N columns (3 headers → 4 total)
        assert len(units) >= 2

    def test_table_summary_unit_uses_table_summary_text(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element(table_summary="Students grades overview")
        units = builder.build([table])

        summary_units = [
            u for u in units if u.metadata.get("is_table_summary") is True
        ]
        assert len(summary_units) == 1
        assert summary_units[0].embedding_text == "Students grades overview"

    def test_table_column_units_contain_header_and_data(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element(
            table_headers=["Name", "Score"],
            table_rows=[["Alice", "95"], ["Bob", "87"]],
        )
        units = builder.build([table])

        column_units = [
            u for u in units if u.metadata.get("is_table_summary") is False
        ]
        assert len(column_units) >= 1

        # Each column unit should contain header text
        embedding_texts = [u.embedding_text for u in column_units]
        assert any("Name:" in t for t in embedding_texts)
        assert any("Score:" in t for t in embedding_texts)

    def test_table_without_headers_produces_summary_plus_content(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element(
            table_headers=[],
            table_rows=[["val1", "val2"], ["val3", "val4"]],
            table_summary="A data table",
        )
        units = builder.build([table])

        # Should still produce minimum 2 units
        assert len(units) >= 2

    def test_table_units_share_parent_element_id(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element(element_id="table-parent-123")
        units = builder.build([table])

        for unit in units:
            assert unit.parent_element_id == "table-parent-123"

    def test_table_units_have_sibling_ids(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element()
        units = builder.build([table])

        assert len(units) >= 2
        all_ids = {u.retrieval_id for u in units}
        for unit in units:
            for sib_id in unit.sibling_ids:
                assert sib_id in all_ids
                assert sib_id != unit.retrieval_id

    def test_table_minimum_two_units_even_with_single_header(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element(
            table_headers=["Value"],
            table_rows=[["10"], ["20"], ["30"]],
            table_summary="Simple value table",
        )
        units = builder.build([table])

        assert len(units) >= 2


# ---------------------------------------------------------------------------
# Tests for TEXT sibling references (Req 4.3, 4.8)
# ---------------------------------------------------------------------------


class TestTextSiblingReferences:
    """Tests for TEXT chunked elements with sibling_ids."""

    def test_single_text_chunk_has_empty_sibling_ids(self) -> None:
        builder = RetrievalUnitBuilder()
        text_elem = _make_text_element()
        units = builder.build([text_elem])

        assert len(units) == 1
        assert units[0].sibling_ids == []

    def test_multiple_chunks_same_parent_have_bidirectional_siblings(self) -> None:
        builder = RetrievalUnitBuilder()
        # Multiple chunks from same parent element
        chunk1 = _make_text_element(
            element_id="parent-1", embedding_text="First chunk of text."
        )
        chunk2 = _make_text_element(
            element_id="parent-1", embedding_text="Second chunk of text."
        )
        chunk3 = _make_text_element(
            element_id="parent-1", embedding_text="Third chunk of text."
        )

        units = builder.build([chunk1, chunk2, chunk3])

        assert len(units) == 3
        all_ids = {u.retrieval_id for u in units}

        for unit in units:
            # Each unit should reference all other siblings
            assert len(unit.sibling_ids) == 2
            for sib_id in unit.sibling_ids:
                assert sib_id in all_ids
                assert sib_id != unit.retrieval_id

    def test_sibling_ids_reference_same_parent_element_id(self) -> None:
        builder = RetrievalUnitBuilder()
        chunk1 = _make_text_element(
            element_id="parent-x", embedding_text="Chunk A."
        )
        chunk2 = _make_text_element(
            element_id="parent-x", embedding_text="Chunk B."
        )

        units = builder.build([chunk1, chunk2])

        for unit in units:
            assert unit.parent_element_id == "parent-x"
            for sib_id in unit.sibling_ids:
                sibling = next(u for u in units if u.retrieval_id == sib_id)
                assert sibling.parent_element_id == unit.parent_element_id

    def test_different_parent_ids_not_siblings(self) -> None:
        builder = RetrievalUnitBuilder()
        chunk_a = _make_text_element(
            element_id="parent-a", embedding_text="Text from parent A."
        )
        chunk_b = _make_text_element(
            element_id="parent-b", embedding_text="Text from parent B."
        )

        units = builder.build([chunk_a, chunk_b])

        assert len(units) == 2
        # Each is a single chunk from its parent → empty sibling_ids
        for unit in units:
            assert unit.sibling_ids == []


# ---------------------------------------------------------------------------
# Tests for IMAGE (Req 4.4)
# ---------------------------------------------------------------------------


class TestImageUnit:
    """Tests for IMAGE → single unit with empty sibling_ids."""

    def test_image_produces_single_unit(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element()
        units = builder.build([image])

        assert len(units) == 1

    def test_image_unit_has_empty_sibling_ids(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element()
        units = builder.build([image])

        assert units[0].sibling_ids == []

    def test_image_unit_has_correct_embedding_text(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element(
            embedding_text="Diagram of cell division process"
        )
        units = builder.build([image])

        assert units[0].embedding_text == "Diagram of cell division process"

    def test_image_unit_parent_element_id(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element(element_id="img-42")
        units = builder.build([image])

        assert units[0].parent_element_id == "img-42"

    def test_image_metadata_includes_s3_key(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element(image_s3_key="s3://bucket/img.png")
        units = builder.build([image])

        assert units[0].metadata.get("image_s3_key") == "s3://bucket/img.png"


# ---------------------------------------------------------------------------
# Tests for FORMULA
# ---------------------------------------------------------------------------


class TestFormulaUnit:
    """Tests for FORMULA → single unit."""

    def test_formula_produces_single_unit(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element()
        units = builder.build([formula])

        assert len(units) == 1

    def test_formula_unit_has_empty_sibling_ids(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element()
        units = builder.build([formula])

        assert units[0].sibling_ids == []

    def test_formula_unit_embedding_text(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element(
            embedding_text="Euler's formula: e^(ix) = cos(x) + i*sin(x)"
        )
        units = builder.build([formula])

        assert units[0].embedding_text == "Euler's formula: e^(ix) = cos(x) + i*sin(x)"

    def test_formula_metadata_includes_latex(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element(latex_repr="E = mc^2")
        units = builder.build([formula])

        assert units[0].metadata.get("latex_repr") == "E = mc^2"

    def test_formula_metadata_includes_concepts(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element(
            formula_concepts=["mass-energy equivalence"]
        )
        units = builder.build([formula])

        assert units[0].metadata.get("formula_concepts") == [
            "mass-energy equivalence"
        ]


# ---------------------------------------------------------------------------
# Tests for validation (Req 4.5, 4.7)
# ---------------------------------------------------------------------------


class TestValidation:
    """Tests for embedding_text validation and discarding invalid elements."""

    def test_empty_embedding_text_discarded(self) -> None:
        builder = RetrievalUnitBuilder()
        text_elem = _make_text_element(embedding_text="")
        units = builder.build([text_elem])

        assert len(units) == 0

    def test_whitespace_only_embedding_text_discarded(self) -> None:
        builder = RetrievalUnitBuilder()
        text_elem = _make_text_element(embedding_text="   \t\n  ")
        units = builder.build([text_elem])

        assert len(units) == 0

    def test_image_with_empty_embedding_text_and_no_description_discarded(
        self,
    ) -> None:
        builder = RetrievalUnitBuilder()
        image = EnrichedElement(
            element_id="img-empty",
            element_type=ElementType.IMAGE,
            provenance=Provenance(page_num=1),
            embedding_text="",
            image_description="",
        )
        units = builder.build([image])

        assert len(units) == 0

    def test_formula_with_empty_embedding_text_discarded(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element(embedding_text="")
        units = builder.build([formula])

        assert len(units) == 0

    def test_valid_elements_among_invalid_ones_still_produced(self) -> None:
        builder = RetrievalUnitBuilder()
        valid = _make_text_element(
            element_id="valid", embedding_text="Valid content."
        )
        invalid = _make_text_element(
            element_id="invalid", embedding_text="   "
        )
        units = builder.build([valid, invalid])

        assert len(units) == 1
        assert units[0].embedding_text == "Valid content."

    def test_processing_never_halts_on_invalid_elements(self) -> None:
        builder = RetrievalUnitBuilder()
        elements = [
            _make_text_element(element_id="a", embedding_text=""),
            _make_text_element(element_id="b", embedding_text="Valid."),
            _make_image_element(element_id="c"),
            _make_formula_element(element_id="d", embedding_text="   "),
        ]
        units = builder.build(elements)

        # Should have: 1 valid text + 1 image = 2 units
        assert len(units) == 2


# ---------------------------------------------------------------------------
# Tests for parent_element_id (Req 4.1, 4.6)
# ---------------------------------------------------------------------------


class TestParentElementId:
    """Tests that parent_element_id is correctly assigned from source element."""

    def test_text_parent_element_id(self) -> None:
        builder = RetrievalUnitBuilder()
        text = _make_text_element(element_id="source-elem-abc")
        units = builder.build([text])

        assert units[0].parent_element_id == "source-elem-abc"

    def test_table_all_units_share_parent_id(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element(element_id="table-xyz")
        units = builder.build([table])

        for unit in units:
            assert unit.parent_element_id == "table-xyz"

    def test_image_parent_element_id(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element(element_id="img-123")
        units = builder.build([image])

        assert units[0].parent_element_id == "img-123"

    def test_formula_parent_element_id(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element(element_id="formula-456")
        units = builder.build([formula])

        assert units[0].parent_element_id == "formula-456"


# ---------------------------------------------------------------------------
# Tests for embedding_version
# ---------------------------------------------------------------------------


class TestEmbeddingVersion:
    """Tests that embedding_version is always set."""

    def test_text_units_have_embedding_version(self) -> None:
        builder = RetrievalUnitBuilder()
        text = _make_text_element()
        units = builder.build([text])

        for unit in units:
            assert unit.embedding_version == EMBEDDING_VERSION
            assert unit.embedding_version != ""

    def test_table_units_have_embedding_version(self) -> None:
        builder = RetrievalUnitBuilder()
        table = _make_table_element()
        units = builder.build([table])

        for unit in units:
            assert unit.embedding_version == EMBEDDING_VERSION

    def test_image_units_have_embedding_version(self) -> None:
        builder = RetrievalUnitBuilder()
        image = _make_image_element()
        units = builder.build([image])

        for unit in units:
            assert unit.embedding_version == EMBEDDING_VERSION

    def test_formula_units_have_embedding_version(self) -> None:
        builder = RetrievalUnitBuilder()
        formula = _make_formula_element()
        units = builder.build([formula])

        for unit in units:
            assert unit.embedding_version == EMBEDDING_VERSION


# ---------------------------------------------------------------------------
# Tests for mixed element types
# ---------------------------------------------------------------------------


class TestMixedElements:
    """Tests for processing mixed element types in a single batch."""

    def test_mixed_types_all_processed(self) -> None:
        builder = RetrievalUnitBuilder()
        elements = [
            _make_text_element(element_id="t1"),
            _make_table_element(element_id="tbl1"),
            _make_image_element(element_id="img1"),
            _make_formula_element(element_id="f1"),
        ]
        units = builder.build(elements)

        # 1 text + 4 table (1 summary + 3 cols) + 1 image + 1 formula = 7
        assert len(units) >= 4  # At minimum: 1 text + 2 table + 1 image

        types = {u.element_type for u in units}
        assert ElementType.TEXT in types
        assert ElementType.TABLE in types
        assert ElementType.IMAGE in types
        assert ElementType.FORMULA in types

    def test_empty_input_returns_empty_list(self) -> None:
        builder = RetrievalUnitBuilder()
        units = builder.build([])
        assert units == []

    def test_all_retrieval_ids_unique(self) -> None:
        builder = RetrievalUnitBuilder()
        elements = [
            _make_text_element(element_id="t1", embedding_text="Chunk 1."),
            _make_text_element(element_id="t1", embedding_text="Chunk 2."),
            _make_table_element(element_id="tbl1"),
            _make_image_element(element_id="img1"),
            _make_formula_element(element_id="f1"),
        ]
        units = builder.build(elements)

        ids = [u.retrieval_id for u in units]
        assert len(ids) == len(set(ids)), "retrieval_ids must be unique"
