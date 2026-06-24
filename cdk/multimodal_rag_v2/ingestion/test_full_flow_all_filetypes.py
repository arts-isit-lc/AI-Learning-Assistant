"""Integration tests: full flow from file bytes → AdapterRegistry → IRBuilder → DocumentIR.

Tests every supported file type end-to-end through the ingestion pipeline
(excluding PDF and PPTX which require native libraries that may not be installed locally).

Supported file types per handler.py:
- pdf (requires PyMuPDF — tested separately)
- pptx (requires python-pptx — tested separately)
- docx (requires python-docx — tested separately)
- html, htm
- png, jpeg, jpg, gif, tiff, tif, bmp, webp
- tex, latex
- csv
- json
"""

from __future__ import annotations

import json

import pytest

from ..models.data_models import (
    DocumentIR,
    ElementType,
    FileMetadata,
    IRElement,
    IR_VERSION,
)
from .adapter_registry import AdapterRegistry
from .adapters.csv_adapter import CsvAdapter
from .adapters.html_adapter import HtmlAdapter
from .adapters.image_adapter import ImageAdapter
from .adapters.json_adapter import JsonAdapter
from .adapters.latex_adapter import LatexAdapter
from .ir_builder import IRBuilder


# ---------------------------------------------------------------------------
# Setup: Registry with all non-native-library adapters
# ---------------------------------------------------------------------------


@pytest.fixture
def registry() -> AdapterRegistry:
    """AdapterRegistry with all adapters that don't require native C libraries."""
    reg = AdapterRegistry()
    reg.register(["html", "htm"], HtmlAdapter())
    reg.register(["png", "jpeg", "jpg", "gif", "tiff", "tif", "bmp", "webp"], ImageAdapter())
    reg.register(["tex", "latex"], LatexAdapter())
    reg.register(["csv"], CsvAdapter())
    reg.register(["json"], JsonAdapter())
    return reg


@pytest.fixture
def ir_builder() -> IRBuilder:
    return IRBuilder()


def _make_metadata(extension: str, file_name: str = "test_file") -> FileMetadata:
    return FileMetadata(
        course_id="course-001",
        module_id="module-001",
        file_id=f"{file_name}-id",
        file_key=f"courses/course-001/module-001/{file_name}.{extension}",
        file_size=1024,
        extension=extension,
    )


# ---------------------------------------------------------------------------
# Integration Tests: HTML
# ---------------------------------------------------------------------------


class TestHTMLFullFlow:
    """HTML files → adapter → IR builder → DocumentIR."""

    def test_html_with_text_and_table(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        html_content = b"""
        <html><body>
            <h1>Introduction to Algorithms</h1>
            <p>This chapter covers sorting algorithms.</p>
            <table>
                <tr><th>Algorithm</th><th>Complexity</th></tr>
                <tr><td>Bubble Sort</td><td>O(n^2)</td></tr>
                <tr><td>Merge Sort</td><td>O(n log n)</td></tr>
            </table>
        </body></html>
        """
        metadata = _make_metadata("html", "algorithms")

        raw_elements = registry.process_file(html_content, metadata)
        assert len(raw_elements) > 0

        doc_ir = ir_builder.build(raw_elements, metadata)
        assert isinstance(doc_ir, DocumentIR)
        assert doc_ir.ir_version == IR_VERSION
        assert len(doc_ir.elements) > 0

        # Should have TEXT and TABLE elements
        types = {e.element_type for e in doc_ir.elements}
        assert ElementType.TEXT in types
        assert ElementType.TABLE in types

    def test_htm_extension_also_works(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        html_content = b"<html><body><p>Hello world</p></body></html>"
        metadata = _make_metadata("htm", "page")

        raw_elements = registry.process_file(html_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) >= 1
        assert doc_ir.elements[0].element_type == ElementType.TEXT

    def test_html_with_base64_image(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        # Minimal 1x1 PNG as base64
        png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        html_content = f'<html><body><img src="data:image/png;base64,{png_b64}" alt="test"></body></html>'.encode()
        metadata = _make_metadata("html", "with_image")

        raw_elements = registry.process_file(html_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        types = {e.element_type for e in doc_ir.elements}
        assert ElementType.IMAGE in types


# ---------------------------------------------------------------------------
# Integration Tests: Image files (standalone)
# ---------------------------------------------------------------------------


class TestImageFullFlow:
    """Standalone image files → adapter → IR builder → DocumentIR."""

    @pytest.mark.parametrize("ext", ["png", "jpeg", "jpg", "gif", "webp", "bmp", "tiff", "tif"])
    def test_all_image_extensions_produce_single_image_element(
        self, registry: AdapterRegistry, ir_builder: IRBuilder, ext: str
    ) -> None:
        # Fake image bytes (adapter doesn't validate image format, just passes bytes through)
        image_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
        metadata = _make_metadata(ext, f"photo.{ext}")

        raw_elements = registry.process_file(image_bytes, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) == 1
        assert doc_ir.elements[0].element_type == ElementType.IMAGE
        assert isinstance(doc_ir.elements[0].content, bytes)

    def test_image_ir_element_has_correct_provenance(
        self, registry: AdapterRegistry, ir_builder: IRBuilder
    ) -> None:
        image_bytes = b"\xff\xd8\xff\xe0" + b"\x01" * 100
        metadata = _make_metadata("jpeg", "photo")

        raw_elements = registry.process_file(image_bytes, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert doc_ir.elements[0].provenance.page_num == 1
        assert doc_ir.elements[0].provenance.position_index == 0


# ---------------------------------------------------------------------------
# Integration Tests: LaTeX
# ---------------------------------------------------------------------------


class TestLatexFullFlow:
    """LaTeX files → adapter → IR builder → DocumentIR."""

    def test_latex_with_text_and_formula(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        latex_content = rb"""
\documentclass{article}
\begin{document}
The quadratic formula is:
$x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$
This gives us the roots.
\end{document}
"""
        metadata = _make_metadata("tex", "math_notes")

        raw_elements = registry.process_file(latex_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) > 0
        types = {e.element_type for e in doc_ir.elements}
        assert ElementType.TEXT in types
        assert ElementType.FORMULA in types

    def test_latex_extension_works(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        latex_content = rb"Hello from LaTeX. $E=mc^2$"
        metadata = _make_metadata("latex", "physics")

        raw_elements = registry.process_file(latex_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) >= 1


# ---------------------------------------------------------------------------
# Integration Tests: CSV
# ---------------------------------------------------------------------------


class TestCSVFullFlow:
    """CSV files → adapter → IR builder → DocumentIR."""

    def test_csv_produces_table_element(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        csv_content = b"algorithm,time_complexity,space_complexity\nmerge_sort,O(n log n),O(n)\nquick_sort,O(n log n),O(log n)\n"
        metadata = _make_metadata("csv", "algo_comparison")

        raw_elements = registry.process_file(csv_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) == 1
        assert doc_ir.elements[0].element_type == ElementType.TABLE
        assert "merge_sort" in doc_ir.elements[0].content

    def test_csv_ir_element_has_valid_hash(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        csv_content = b"x,y\n1,2\n3,4\n"
        metadata = _make_metadata("csv", "data")

        raw_elements = registry.process_file(csv_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert doc_ir.elements[0].content_hash
        assert len(doc_ir.elements[0].content_hash) == 64  # SHA256 hex


# ---------------------------------------------------------------------------
# Integration Tests: JSON
# ---------------------------------------------------------------------------


class TestJSONFullFlow:
    """JSON files → adapter → IR builder → DocumentIR."""

    def test_json_array_of_objects_produces_table(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        data = [
            {"algorithm": "binary_search", "complexity": "O(log n)"},
            {"algorithm": "linear_search", "complexity": "O(n)"},
        ]
        content = json.dumps(data).encode()
        metadata = _make_metadata("json", "algorithms")

        raw_elements = registry.process_file(content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) == 1
        assert doc_ir.elements[0].element_type == ElementType.TABLE

    def test_json_nested_object_produces_text(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        data = {"config": {"learning_rate": 0.01, "epochs": 100}, "model": "transformer"}
        content = json.dumps(data).encode()
        metadata = _make_metadata("json", "config")

        raw_elements = registry.process_file(content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert len(doc_ir.elements) == 1
        assert doc_ir.elements[0].element_type == ElementType.TEXT


# ---------------------------------------------------------------------------
# Integration Tests: DocumentIR properties
# ---------------------------------------------------------------------------


class TestDocumentIRProperties:
    """Verify DocumentIR has correct structure after full flow."""

    def test_element_count_is_correct(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        html_content = b"""
        <html><body>
            <h1>Title</h1>
            <p>Paragraph 1</p>
            <p>Paragraph 2</p>
            <table><tr><td>Cell</td></tr></table>
        </body></html>
        """
        metadata = _make_metadata("html", "doc")

        raw_elements = registry.process_file(html_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        # element_count should match actual element counts by type
        text_count = sum(1 for e in doc_ir.elements if e.element_type == ElementType.TEXT)
        table_count = sum(1 for e in doc_ir.elements if e.element_type == ElementType.TABLE)
        assert doc_ir.element_count.get(ElementType.TEXT, 0) == text_count
        assert doc_ir.element_count.get(ElementType.TABLE, 0) == table_count

    def test_deduplication_works(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        """Duplicate content produces only one IR element."""
        html_content = b"""
        <html><body>
            <p>Same content here</p>
            <p>Same content here</p>
        </body></html>
        """
        metadata = _make_metadata("html", "dupe")

        raw_elements = registry.process_file(html_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        # Only one element because deduplication removes the second identical paragraph
        text_elements = [e for e in doc_ir.elements if e.element_type == ElementType.TEXT]
        assert len(text_elements) == 1

    def test_file_metadata_preserved(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        csv_content = b"a,b\n1,2\n"
        metadata = _make_metadata("csv", "meta_test")

        raw_elements = registry.process_file(csv_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        assert doc_ir.file_metadata.course_id == "course-001"
        assert doc_ir.file_metadata.module_id == "module-001"
        assert doc_ir.file_metadata.extension == "csv"

    def test_elements_sorted_by_provenance(self, registry: AdapterRegistry, ir_builder: IRBuilder) -> None:
        """Elements are sorted by page_num then position_index."""
        html_content = b"""
        <html><body>
            <h1>First</h1>
            <p>Second</p>
            <p>Third</p>
        </body></html>
        """
        metadata = _make_metadata("html", "sorted")

        raw_elements = registry.process_file(html_content, metadata)
        doc_ir = ir_builder.build(raw_elements, metadata)

        # All elements should be in provenance order
        for i in range(1, len(doc_ir.elements)):
            prev = doc_ir.elements[i - 1]
            curr = doc_ir.elements[i]
            prev_key = (prev.provenance.page_num or 0, prev.provenance.position_index)
            curr_key = (curr.provenance.page_num or 0, curr.provenance.position_index)
            assert prev_key <= curr_key


# ---------------------------------------------------------------------------
# Integration Tests: Error handling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    """Errors are raised correctly for invalid inputs."""

    def test_unsupported_extension_raises(self, registry: AdapterRegistry) -> None:
        from .exceptions import UnsupportedFormatError
        metadata = _make_metadata("exe", "malware")

        with pytest.raises(UnsupportedFormatError):
            registry.process_file(b"content", metadata)

    def test_oversized_file_raises(self, registry: AdapterRegistry) -> None:
        from .exceptions import FileSizeExceededError
        metadata = FileMetadata(
            course_id="c",
            module_id="m",
            file_id="f",
            file_key="courses/c/m/big.csv",
            file_size=300 * 1024 * 1024,  # 300 MB
            extension="csv",
        )

        with pytest.raises(FileSizeExceededError):
            registry.process_file(b"small content", metadata)

    def test_empty_csv_raises(self, registry: AdapterRegistry) -> None:
        from .exceptions import ExtractionFailureError
        metadata = _make_metadata("csv", "empty")

        with pytest.raises(ExtractionFailureError):
            registry.process_file(b"", metadata)

    def test_invalid_json_raises(self, registry: AdapterRegistry) -> None:
        from .exceptions import ExtractionFailureError
        metadata = _make_metadata("json", "broken")

        with pytest.raises(ExtractionFailureError):
            registry.process_file(b"{not valid json!", metadata)
