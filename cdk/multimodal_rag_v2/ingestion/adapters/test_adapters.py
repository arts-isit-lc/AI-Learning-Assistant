"""Unit tests for image, LaTeX, CSV, and JSON adapters."""

from __future__ import annotations

import json

import pytest

from ...models.data_models import ElementType, FileMetadata, Provenance
from ..exceptions import ExtractionFailureError
from .csv_adapter import CsvAdapter
from .image_adapter import ImageAdapter
from .json_adapter import JsonAdapter
from .latex_adapter import LatexAdapter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_metadata(
    file_key: str = "courses/CS101/module1/file.txt",
    extension: str = "txt",
    file_size: int = 1024,
) -> FileMetadata:
    return FileMetadata(
        course_id="CS101",
        module_id="module1",
        file_id="file-001",
        file_key=file_key,
        file_size=file_size,
        extension=extension,
    )


# ===========================================================================
# ImageAdapter Tests
# ===========================================================================


class TestImageAdapter:
    def test_extracts_single_image_element(self) -> None:
        adapter = ImageAdapter()
        content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100  # fake PNG header
        metadata = _make_metadata(file_key="images/photo.png", extension="png")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.IMAGE
        assert result[0].content == content
        assert result[0].provenance.page_num == 1
        assert result[0].provenance.position_index == 0

    def test_preserves_raw_bytes_as_content(self) -> None:
        adapter = ImageAdapter()
        content = b"\xff\xd8\xff\xe0" + b"\x01" * 200  # fake JPEG
        metadata = _make_metadata(file_key="img.jpeg", extension="jpeg")

        result = adapter.extract(content, metadata)

        assert result[0].content is content  # exact same bytes object

    def test_empty_content_raises_extraction_failure(self) -> None:
        adapter = ImageAdapter()
        metadata = _make_metadata(file_key="empty.png", extension="png")

        with pytest.raises(ExtractionFailureError) as exc_info:
            adapter.extract(b"", metadata)
        assert "empty" in str(exc_info.value).lower()

    def test_raw_metadata_includes_source_format(self) -> None:
        adapter = ImageAdapter()
        content = b"\x00" * 50
        metadata = _make_metadata(file_key="pic.webp", extension="webp")

        result = adapter.extract(content, metadata)

        assert result[0].raw_metadata["source_format"] == "webp"


# ===========================================================================
# CsvAdapter Tests
# ===========================================================================


class TestCsvAdapter:
    def test_extracts_single_table_element(self) -> None:
        adapter = CsvAdapter()
        csv_content = b"name,age,city\nAlice,30,NYC\nBob,25,LA\n"
        metadata = _make_metadata(file_key="data.csv", extension="csv")

        result = adapter.extract(csv_content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TABLE
        assert result[0].provenance.page_num == 1
        assert result[0].provenance.position_index == 0

    def test_content_is_csv_text(self) -> None:
        adapter = CsvAdapter()
        csv_content = b"col1,col2\nval1,val2\n"
        metadata = _make_metadata(file_key="data.csv", extension="csv")

        result = adapter.extract(csv_content, metadata)

        assert isinstance(result[0].content, str)
        assert "col1,col2" in result[0].content

    def test_metadata_includes_row_and_column_count(self) -> None:
        adapter = CsvAdapter()
        csv_content = b"a,b,c\n1,2,3\n4,5,6\n"
        metadata = _make_metadata(file_key="data.csv", extension="csv")

        result = adapter.extract(csv_content, metadata)

        assert result[0].raw_metadata["row_count"] == 3  # header + 2 data rows
        assert result[0].raw_metadata["column_count"] == 3

    def test_empty_content_raises_extraction_failure(self) -> None:
        adapter = CsvAdapter()
        metadata = _make_metadata(file_key="empty.csv", extension="csv")

        with pytest.raises(ExtractionFailureError):
            adapter.extract(b"", metadata)

    def test_whitespace_only_raises_extraction_failure(self) -> None:
        adapter = CsvAdapter()
        metadata = _make_metadata(file_key="blank.csv", extension="csv")

        with pytest.raises(ExtractionFailureError):
            adapter.extract(b"   \n  \t  ", metadata)

    def test_single_row_csv(self) -> None:
        adapter = CsvAdapter()
        csv_content = b"header1,header2\n"
        metadata = _make_metadata(file_key="single.csv", extension="csv")

        result = adapter.extract(csv_content, metadata)

        assert len(result) == 1
        assert result[0].raw_metadata["row_count"] == 1


# ===========================================================================
# JsonAdapter Tests
# ===========================================================================


class TestJsonAdapter:
    def test_array_of_objects_extracted_as_table(self) -> None:
        adapter = JsonAdapter()
        data = [
            {"name": "Alice", "age": 30},
            {"name": "Bob", "age": 25},
            {"name": "Charlie", "age": 35},
        ]
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="data.json", extension="json")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TABLE

    def test_nested_object_extracted_as_text(self) -> None:
        adapter = JsonAdapter()
        data = {"config": {"nested": {"deep": True}}, "name": "test"}
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="config.json", extension="json")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TEXT

    def test_single_object_extracted_as_text(self) -> None:
        adapter = JsonAdapter()
        data = {"key": "value", "number": 42}
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="obj.json", extension="json")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TEXT

    def test_empty_array_extracted_as_text(self) -> None:
        adapter = JsonAdapter()
        content = b"[]"
        metadata = _make_metadata(file_key="empty.json", extension="json")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TEXT

    def test_array_of_primitives_extracted_as_text(self) -> None:
        adapter = JsonAdapter()
        data = [1, 2, 3, 4, 5]
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="nums.json", extension="json")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TEXT

    def test_inconsistent_keys_extracted_as_text(self) -> None:
        """Array of objects with no common keys should be TEXT."""
        adapter = JsonAdapter()
        data = [{"a": 1}, {"b": 2}, {"c": 3}]
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="mixed.json", extension="json")

        result = adapter.extract(content, metadata)

        assert len(result) == 1
        assert result[0].element_type == ElementType.TEXT

    def test_provenance_is_correct(self) -> None:
        adapter = JsonAdapter()
        content = json.dumps({"key": "val"}).encode("utf-8")
        metadata = _make_metadata(file_key="test.json", extension="json")

        result = adapter.extract(content, metadata)

        assert result[0].provenance.page_num == 1
        assert result[0].provenance.position_index == 0

    def test_empty_content_raises_extraction_failure(self) -> None:
        adapter = JsonAdapter()
        metadata = _make_metadata(file_key="empty.json", extension="json")

        with pytest.raises(ExtractionFailureError):
            adapter.extract(b"", metadata)

    def test_invalid_json_raises_extraction_failure(self) -> None:
        adapter = JsonAdapter()
        metadata = _make_metadata(file_key="broken.json", extension="json")

        with pytest.raises(ExtractionFailureError):
            adapter.extract(b"{invalid json", metadata)

    def test_table_metadata_includes_structure(self) -> None:
        adapter = JsonAdapter()
        data = [{"x": 1, "y": 2}, {"x": 3, "y": 4}]
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="table.json", extension="json")

        result = adapter.extract(content, metadata)

        assert result[0].raw_metadata["structure"] == "array_of_objects"
        assert result[0].raw_metadata["row_count"] == 2

    def test_partially_overlapping_keys_is_tabular(self) -> None:
        """Objects with at least one common key across all items → TABLE."""
        adapter = JsonAdapter()
        data = [
            {"id": 1, "name": "Alice", "extra": "x"},
            {"id": 2, "name": "Bob"},
            {"id": 3, "name": "Charlie", "other": "y"},
        ]
        content = json.dumps(data).encode("utf-8")
        metadata = _make_metadata(file_key="partial.json", extension="json")

        result = adapter.extract(content, metadata)

        assert result[0].element_type == ElementType.TABLE


# ===========================================================================
# LatexAdapter Tests
# ===========================================================================


class TestLatexAdapter:
    def test_extracts_text_and_formulas(self) -> None:
        adapter = LatexAdapter()
        latex_content = rb"""
\documentclass{article}
\begin{document}
Hello world, this is some text.
$E = mc^2$
More text here.
\end{document}
"""
        metadata = _make_metadata(file_key="doc.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        # Should have at least one TEXT and one FORMULA element
        types = [e.element_type for e in result]
        assert ElementType.TEXT in types
        assert ElementType.FORMULA in types

    def test_inline_math_produces_formula(self) -> None:
        adapter = LatexAdapter()
        latex_content = rb"The energy formula is $E = mc^2$ and that's important."
        metadata = _make_metadata(file_key="inline.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        formula_elements = [e for e in result if e.element_type == ElementType.FORMULA]
        assert len(formula_elements) >= 1

    def test_display_math_produces_formula(self) -> None:
        adapter = LatexAdapter()
        latex_content = rb"Text before. $$\int_0^\infty e^{-x} dx = 1$$ Text after."
        metadata = _make_metadata(file_key="display.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        formula_elements = [e for e in result if e.element_type == ElementType.FORMULA]
        assert len(formula_elements) >= 1

    def test_equation_environment_produces_formula(self) -> None:
        adapter = LatexAdapter()
        latex_content = rb"""
Some introductory text.
\begin{equation}
F = ma
\end{equation}
Conclusion text.
"""
        metadata = _make_metadata(file_key="eq.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        formula_elements = [e for e in result if e.element_type == ElementType.FORMULA]
        assert len(formula_elements) >= 1

    def test_provenance_position_index_increments(self) -> None:
        adapter = LatexAdapter()
        latex_content = rb"Text one. $x=1$ Text two. $y=2$"
        metadata = _make_metadata(file_key="multi.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        # Position indices should be monotonically increasing
        indices = [e.provenance.position_index for e in result]
        assert indices == sorted(indices)
        assert len(set(indices)) == len(indices)  # all unique

    def test_empty_content_raises_extraction_failure(self) -> None:
        adapter = LatexAdapter()
        metadata = _make_metadata(file_key="empty.tex", extension="tex")

        with pytest.raises(ExtractionFailureError):
            adapter.extract(b"", metadata)

    def test_whitespace_only_raises_extraction_failure(self) -> None:
        adapter = LatexAdapter()
        metadata = _make_metadata(file_key="blank.tex", extension="tex")

        with pytest.raises(ExtractionFailureError):
            adapter.extract(b"   \n  \t  ", metadata)

    def test_plain_text_produces_text_element(self) -> None:
        adapter = LatexAdapter()
        latex_content = b"Just plain text without any math."
        metadata = _make_metadata(file_key="plain.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        assert all(e.element_type == ElementType.TEXT for e in result)
        assert len(result) >= 1

    def test_all_elements_have_page_num_one(self) -> None:
        adapter = LatexAdapter()
        latex_content = rb"Hello $x=1$ world $y=2$."
        metadata = _make_metadata(file_key="test.tex", extension="tex")

        result = adapter.extract(latex_content, metadata)

        for element in result:
            assert element.provenance.page_num == 1
