"""Unit tests for DocumentSummaryGenerator — metadata extraction, summary generation, RetrievalUnit construction."""

from __future__ import annotations

import json
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from ..models.data_models import (
    DocumentIR,
    DocumentMetadata,
    DocumentSummary,
    ElementType,
    EMBEDDING_VERSION,
    ENRICHMENT_VERSION,
    FileMetadata,
    IRElement,
    Provenance,
    RetrievalUnit,
)
from .document_summary import (
    DocumentSummaryGenerator,
    _collect_text_content,
    _extract_lecture_number,
    _extract_title,
    _extract_week,
    _generate_heuristic_summary,
)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_file_metadata(
    file_key: str = "courses/cs101/week_3/Lecture_7.pdf",
    module_id: str = "module-01",
) -> FileMetadata:
    return FileMetadata(
        course_id="cs101",
        module_id=module_id,
        file_id="file-001",
        file_key=file_key,
        file_size=1024,
        extension="pdf",
    )


def _make_text_element(
    content: str = "This is sample text content for testing.",
    element_id: str = "elem-001",
    page_num: int = 1,
) -> IRElement:
    return IRElement(
        element_id=element_id,
        content=content,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=page_num, position_index=0),
        content_hash="hash-001",
    )


def _make_document_ir(
    elements: list[IRElement] | None = None,
    file_key: str = "courses/cs101/week_3/Lecture_7.pdf",
    module_id: str = "module-01",
) -> DocumentIR:
    if elements is None:
        elements = [
            _make_text_element("Introduction to linear algebra. This lecture covers vectors and matrices."),
            _make_text_element(
                "Vectors are fundamental objects in linear algebra. They represent magnitude and direction.",
                element_id="elem-002",
                page_num=2,
            ),
        ]
    return DocumentIR(
        file_metadata=_make_file_metadata(file_key=file_key, module_id=module_id),
        elements=elements,
        element_count={ElementType.TEXT: len(elements)},
    )


def _make_bedrock_response(
    topics: list[str] | None = None,
    overview: str = "This document covers linear algebra fundamentals.",
    learning_objectives: list[str] | None = None,
) -> dict:
    """Create a mock Bedrock response body."""
    if topics is None:
        topics = ["linear algebra", "vectors", "matrices"]
    if learning_objectives is None:
        learning_objectives = ["Understand vector operations", "Apply matrix multiplication"]

    response_json = {
        "topics": topics,
        "overview": overview,
        "learning_objectives": learning_objectives,
    }
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(response_json),
            }
        ]
    }


def _mock_bedrock_client(response_body: dict | None = None) -> MagicMock:
    """Create a mock Bedrock client that returns a valid response."""
    if response_body is None:
        response_body = _make_bedrock_response()

    client = MagicMock()
    response_bytes = json.dumps(response_body).encode("utf-8")
    mock_body = BytesIO(response_bytes)
    client.invoke_model.return_value = {"body": mock_body}
    return client


# ---------------------------------------------------------------------------
# Tests: Metadata extraction helpers
# ---------------------------------------------------------------------------


class TestExtractLectureNumber:
    """Tests for _extract_lecture_number."""

    def test_lecture_with_underscore(self):
        assert _extract_lecture_number("courses/cs101/Lecture_7.pdf") == 7

    def test_lecture_with_dash(self):
        assert _extract_lecture_number("courses/cs101/Lecture-12.pdf") == 12

    def test_lecture_with_space(self):
        assert _extract_lecture_number("courses/cs101/Lecture 3.pdf") == 3

    def test_lec_abbreviation(self):
        assert _extract_lecture_number("courses/cs101/lec_5.pptx") == 5

    def test_lec_abbreviation_no_separator(self):
        assert _extract_lecture_number("courses/cs101/lec03.pdf") == 3

    def test_case_insensitive(self):
        assert _extract_lecture_number("courses/cs101/LECTURE_10.pdf") == 10

    def test_no_lecture_number(self):
        assert _extract_lecture_number("courses/cs101/syllabus.pdf") is None

    def test_empty_string(self):
        assert _extract_lecture_number("") is None


class TestExtractWeek:
    """Tests for _extract_week."""

    def test_week_in_filename(self):
        assert _extract_week("courses/cs101/week_3/notes.pdf", "module-01") == 3

    def test_week_with_dash(self):
        assert _extract_week("courses/cs101/Week-5/slides.pptx", "module-01") == 5

    def test_wk_abbreviation(self):
        assert _extract_week("courses/cs101/wk2_notes.pdf", "module-01") == 2

    def test_week_in_module_id(self):
        assert _extract_week("courses/cs101/slides.pdf", "week_4") == 4

    def test_no_week(self):
        assert _extract_week("courses/cs101/slides.pdf", "module-01") is None

    def test_file_key_takes_precedence_over_module(self):
        assert _extract_week("courses/cs101/week_2/notes.pdf", "week_4") == 2


class TestExtractTitle:
    """Tests for _extract_title."""

    def test_basic_filename(self):
        assert _extract_title("courses/cs101/Linear_Algebra_Intro.pdf") == "Linear Algebra Intro"

    def test_filename_with_dashes(self):
        assert _extract_title("courses/cs101/data-structures-overview.docx") == "data structures overview"

    def test_simple_filename(self):
        assert _extract_title("notes.pdf") == "notes"

    def test_no_extension(self):
        assert _extract_title("my_document") == "my document"

    def test_empty_after_cleaning(self):
        # Edge case: file key with only extension
        assert _extract_title(".pdf") is None


# ---------------------------------------------------------------------------
# Tests: _collect_text_content
# ---------------------------------------------------------------------------


class TestCollectTextContent:
    """Tests for _collect_text_content."""

    def test_collects_text_elements(self):
        doc_ir = _make_document_ir()
        content = _collect_text_content(doc_ir)
        assert "Introduction to linear algebra" in content
        assert "Vectors are fundamental" in content

    def test_skips_non_text_elements(self):
        elements = [
            _make_text_element("Text content here."),
            IRElement(
                element_id="img-001",
                content=b"image bytes",
                element_type=ElementType.IMAGE,
                provenance=Provenance(page_num=2, position_index=0),
                content_hash="hash-img",
            ),
        ]
        doc_ir = _make_document_ir(elements=elements)
        content = _collect_text_content(doc_ir)
        assert "Text content here" in content
        assert "image bytes" not in content

    def test_respects_max_chars_limit(self):
        long_text = "A" * 3000
        elements = [_make_text_element(long_text)]
        doc_ir = _make_document_ir(elements=elements)
        content = _collect_text_content(doc_ir, max_chars=100)
        assert len(content) <= 100

    def test_empty_document(self):
        doc_ir = _make_document_ir(elements=[])
        content = _collect_text_content(doc_ir)
        assert content == ""


# ---------------------------------------------------------------------------
# Tests: _generate_heuristic_summary
# ---------------------------------------------------------------------------


class TestGenerateHeuristicSummary:
    """Tests for _generate_heuristic_summary."""

    def test_produces_required_fields(self):
        result = _generate_heuristic_summary(
            "Linear algebra covers vectors. Matrices are used for transformations. "
            "Eigenvalues reveal important properties.",
            "Lecture_7.pdf",
        )
        assert "topics" in result
        assert "overview" in result
        assert "learning_objectives" in result

    def test_topics_min_3(self):
        result = _generate_heuristic_summary("Short text.", "notes.pdf")
        assert len(result["topics"]) >= 3

    def test_topics_max_10(self):
        long_text = ". ".join([f"Topic {i} is interesting" for i in range(20)])
        result = _generate_heuristic_summary(long_text, "notes.pdf")
        assert len(result["topics"]) <= 10

    def test_learning_objectives_present(self):
        result = _generate_heuristic_summary("Some content here. More content.", "notes.pdf")
        assert len(result["learning_objectives"]) >= 1


# ---------------------------------------------------------------------------
# Tests: DocumentSummaryGenerator
# ---------------------------------------------------------------------------


class TestDocumentSummaryGeneratorWithBedrock:
    """Tests for DocumentSummaryGenerator with Bedrock client."""

    def test_generate_returns_tuple(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        result = generator.generate(doc_ir)

        assert isinstance(result, tuple)
        assert len(result) == 2
        assert isinstance(result[0], DocumentSummary)
        assert isinstance(result[1], RetrievalUnit)

    def test_document_summary_fields(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        doc_summary, _ = generator.generate(doc_ir)

        assert doc_summary.file_id == "file-001"
        assert len(doc_summary.topics) >= 3
        assert len(doc_summary.topics) <= 10
        assert doc_summary.summary != ""
        assert len(doc_summary.learning_objectives) >= 1
        assert len(doc_summary.learning_objectives) <= 5
        assert doc_summary.enrichment_version == ENRICHMENT_VERSION

    def test_retrieval_unit_metadata(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["is_document_summary"] is True
        assert retrieval_unit.metadata["title"] == "Lecture 7"
        assert retrieval_unit.metadata["lecture_number"] == 7
        assert retrieval_unit.metadata["week"] == 3
        assert retrieval_unit.embedding_version == EMBEDDING_VERSION

    def test_retrieval_unit_parent_element_id(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.parent_element_id == "summary-file-001"

    def test_retrieval_unit_embedding_text_nonempty(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.embedding_text.strip() != ""

    def test_retrieval_unit_sibling_ids_empty(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.sibling_ids == []

    def test_retrieval_unit_element_type_text(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.element_type == ElementType.TEXT

    def test_bedrock_invoked_with_content(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        generator.generate(doc_ir)

        client.invoke_model.assert_called_once()
        call_kwargs = client.invoke_model.call_args[1]
        assert call_kwargs["modelId"] == "us.anthropic.claude-haiku-4-5-20251001-v1:0"


class TestDocumentSummaryGeneratorWithoutBedrock:
    """Tests for DocumentSummaryGenerator without Bedrock (heuristic fallback)."""

    def test_generates_summary_without_client(self):
        generator = DocumentSummaryGenerator(bedrock_client=None)
        doc_ir = _make_document_ir()

        doc_summary, retrieval_unit = generator.generate(doc_ir)

        assert isinstance(doc_summary, DocumentSummary)
        assert isinstance(retrieval_unit, RetrievalUnit)
        assert len(doc_summary.topics) >= 3
        assert doc_summary.summary != ""

    def test_bedrock_failure_uses_heuristic(self):
        client = MagicMock()
        client.invoke_model.side_effect = RuntimeError("Service unavailable")
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        doc_summary, retrieval_unit = generator.generate(doc_ir)

        # Should still produce valid output via heuristic fallback
        assert isinstance(doc_summary, DocumentSummary)
        assert len(doc_summary.topics) >= 3
        assert retrieval_unit.metadata["is_document_summary"] is True


class TestDocumentSummaryMetadataExtraction:
    """Tests for metadata extraction from various filename patterns."""

    def test_lecture_number_extracted(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir(file_key="courses/cs101/Lecture_7.pdf")

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["lecture_number"] == 7

    def test_week_extracted_from_path(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir(file_key="courses/cs101/week_3/notes.pdf")

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["week"] == 3

    def test_week_extracted_from_module_id(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir(
            file_key="courses/cs101/notes.pdf",
            module_id="week_5",
        )

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["week"] == 5

    def test_lecture_number_none_when_not_extractable(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir(file_key="courses/cs101/syllabus.pdf")

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["lecture_number"] is None

    def test_week_none_when_not_extractable(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir(
            file_key="courses/cs101/syllabus.pdf",
            module_id="intro-module",
        )

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["week"] is None

    def test_title_extracted(self):
        client = _mock_bedrock_client()
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir(file_key="courses/cs101/Linear_Algebra_Intro.pdf")

        _, retrieval_unit = generator.generate(doc_ir)

        assert retrieval_unit.metadata["title"] == "Linear Algebra Intro"


class TestDocumentSummaryEdgeCases:
    """Edge case tests for DocumentSummaryGenerator."""

    def test_empty_document_no_elements(self):
        generator = DocumentSummaryGenerator(bedrock_client=None)
        doc_ir = _make_document_ir(elements=[])

        doc_summary, retrieval_unit = generator.generate(doc_ir)

        assert isinstance(doc_summary, DocumentSummary)
        assert retrieval_unit.metadata["is_document_summary"] is True

    def test_bedrock_response_with_code_fences(self):
        response_body = {
            "content": [
                {
                    "type": "text",
                    "text": '```json\n{"topics": ["topic1", "topic2", "topic3"], "overview": "A summary.", "learning_objectives": ["Learn stuff"]}\n```',
                }
            ]
        }
        client = _mock_bedrock_client(response_body=response_body)
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        doc_summary, _ = generator.generate(doc_ir)

        assert "topic1" in doc_summary.topics

    def test_topics_padded_to_minimum_3(self):
        """If Bedrock returns fewer than 3 topics, they are padded."""
        response_body = _make_bedrock_response(
            topics=["only_one"],
            overview="Short overview.",
            learning_objectives=["Learn this"],
        )
        client = _mock_bedrock_client(response_body=response_body)
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        doc_summary, _ = generator.generate(doc_ir)

        assert len(doc_summary.topics) >= 3

    def test_topics_capped_at_10(self):
        """If Bedrock returns more than 10 topics, they are capped."""
        response_body = _make_bedrock_response(
            topics=[f"topic_{i}" for i in range(15)],
        )
        client = _mock_bedrock_client(response_body=response_body)
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        doc_summary, _ = generator.generate(doc_ir)

        assert len(doc_summary.topics) <= 10

    def test_learning_objectives_capped_at_5(self):
        """If Bedrock returns more than 5 objectives, they are capped."""
        response_body = _make_bedrock_response(
            learning_objectives=[f"objective_{i}" for i in range(8)],
        )
        client = _mock_bedrock_client(response_body=response_body)
        generator = DocumentSummaryGenerator(bedrock_client=client)
        doc_ir = _make_document_ir()

        doc_summary, _ = generator.generate(doc_ir)

        assert len(doc_summary.learning_objectives) <= 5
