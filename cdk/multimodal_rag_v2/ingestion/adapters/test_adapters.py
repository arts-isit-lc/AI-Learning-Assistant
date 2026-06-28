"""Unit tests for image, LaTeX, CSV, and JSON adapters."""

from __future__ import annotations

import json

import pytest

from ...models.data_models import ElementType, FileMetadata, Provenance
from ..exceptions import ExtractionFailureError
from .csv_adapter import CsvAdapter
from .html_adapter import HtmlAdapter
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


# ===========================================================================
# HtmlAdapter — URL-referenced images (Issue #3)
# ===========================================================================


class TestHtmlAdapterUrlImages:
    def test_url_image_with_alt_becomes_text_element(self) -> None:
        adapter = HtmlAdapter()
        html = b'<html><body><img src="https://example.com/x.png" alt="A diagram of recursion"></body></html>'
        result = adapter.extract(html, _make_metadata(extension="html"))

        # No string-content IMAGE element should exist (that path is removed).
        for el in result:
            assert not (el.element_type == ElementType.IMAGE and isinstance(el.content, str))

        text_els = [el for el in result if el.element_type == ElementType.TEXT]
        assert any("A diagram of recursion" in str(el.content) for el in text_els)

    def test_url_image_without_alt_is_skipped(self) -> None:
        adapter = HtmlAdapter()
        html = b'<html><body><p>Intro</p><img src="https://example.com/y.png"></body></html>'
        result = adapter.extract(html, _make_metadata(extension="html"))

        # The image contributes nothing; no string IMAGE and no "Image:" text from it.
        for el in result:
            assert not (el.element_type == ElementType.IMAGE and isinstance(el.content, str))

    def test_base64_image_still_produces_bytes_image(self) -> None:
        adapter = HtmlAdapter()
        # 1x1 transparent PNG
        b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
        html = f'<html><body><img src="data:image/png;base64,{b64}" alt="dot"></body></html>'.encode()
        result = adapter.extract(html, _make_metadata(extension="html"))
        image_els = [el for el in result if el.element_type == ElementType.IMAGE]
        assert image_els
        assert all(isinstance(el.content, bytes) for el in image_els)


# ===========================================================================
# LatexAdapter — tabular + includegraphics (Issue #4)
# ===========================================================================


class TestLatexAdapterTablesAndFigures:
    def test_tabular_becomes_table_element(self) -> None:
        adapter = LatexAdapter()
        tex = (
            b"\\documentclass{article}\\begin{document}\n"
            b"\\begin{tabular}{l c}\n\\hline\nName & Score \\\\\n\\hline\n"
            b"Alice & 90 \\\\\nBob & 85 \\\\\n\\hline\n\\end{tabular}\n"
            b"\\end{document}\n"
        )
        result = adapter.extract(tex, _make_metadata(extension="tex"))
        tables = [el for el in result if el.element_type == ElementType.TABLE]
        assert len(tables) == 1
        content = tables[0].content
        assert "Name | Score" in content
        assert "Alice | 90" in content

    def test_includegraphics_becomes_text_reference(self) -> None:
        adapter = LatexAdapter()
        tex = (
            b"\\documentclass{article}\\begin{document}\n"
            b"\\begin{figure}\\includegraphics[width=0.5\\textwidth]{diagram.png}\\end{figure}\n"
            b"\\end{document}\n"
        )
        result = adapter.extract(tex, _make_metadata(extension="tex"))
        text_els = [el for el in result if el.element_type == ElementType.TEXT]
        assert any("diagram.png" in str(el.content) for el in text_els)
        # No raw LaTeX command leaked as its own element
        assert all("\\includegraphics" not in str(el.content) for el in result)


    def test_figure_caption_and_label_extracted(self) -> None:
        adapter = LatexAdapter()
        tex = (
            b"\\documentclass{article}\\begin{document}\n"
            b"\\begin{figure}\n\\includegraphics{bfs.png}\n"
            b"\\caption{BFS traversal order on a sample graph}\n\\label{fig:bfs}\n"
            b"\\end{figure}\n\\end{document}\n"
        )
        result = adapter.extract(tex, _make_metadata(extension="tex"))
        text_els = [el for el in result if el.element_type == ElementType.TEXT]
        fig_text = next(
            (str(el.content) for el in text_els if "BFS traversal" in str(el.content)), ""
        )
        # Caption (the real semantic content), label, and filename are all captured.
        assert "BFS traversal order on a sample graph" in fig_text
        assert "fig:bfs" in fig_text
        assert "bfs.png" in fig_text
        # Filename consumed by the figure env → not duplicated as a bare reference.
        assert sum(1 for el in text_els if "bfs.png" in str(el.content)) == 1
