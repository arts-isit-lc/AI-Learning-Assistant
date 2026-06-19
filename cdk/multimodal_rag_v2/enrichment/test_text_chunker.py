"""Unit tests for TextChunker — semantic chunking without LLM calls."""

from __future__ import annotations

import pytest

from ..models.data_models import (
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    IRElement,
    Provenance,
)
from .text_chunker import (
    TextChunker,
    _SINGLE_CHUNK_THRESHOLD_CHARS,
    _TARGET_CHUNK_MAX_CHARS,
    _split_into_paragraphs,
    _split_into_sentences,
)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _make_text_element(
    content: str = "Hello world",
    page_num: int = 1,
    position_index: int = 0,
    element_id: str = "test-element-id",
    content_hash: str = "test-content-hash",
) -> IRElement:
    return IRElement(
        element_id=element_id,
        content=content,
        element_type=ElementType.TEXT,
        provenance=Provenance(page_num=page_num, position_index=position_index),
        content_hash=content_hash,
    )


def _generate_long_text(num_paragraphs: int = 20, sentences_per_para: int = 5) -> str:
    """Generate text that exceeds the single chunk threshold."""
    paragraphs = []
    for i in range(num_paragraphs):
        sentences = [
            f"This is sentence {j+1} of paragraph {i+1} which contains enough words to be realistic."
            for j in range(sentences_per_para)
        ]
        paragraphs.append(" ".join(sentences))
    return "\n\n".join(paragraphs)


# ---------------------------------------------------------------------------
# Tests for single chunk (short text)
# ---------------------------------------------------------------------------


class TestSingleChunk:
    def test_short_text_produces_single_enriched_element(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="Short text content.")
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == "Short text content."

    def test_text_at_threshold_produces_single_chunk(self) -> None:
        chunker = TextChunker()
        # Exactly at threshold
        content = "a" * _SINGLE_CHUNK_THRESHOLD_CHARS
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == content

    def test_single_paragraph_under_threshold(self) -> None:
        chunker = TextChunker()
        content = "This is a single paragraph with multiple sentences. It has several ideas. But it is still short enough to fit in one chunk."
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == content


# ---------------------------------------------------------------------------
# Tests for multi-chunk (long text)
# ---------------------------------------------------------------------------


class TestMultiChunk:
    def test_long_text_produces_multiple_chunks(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=20, sentences_per_para=5)
        assert len(content) > _SINGLE_CHUNK_THRESHOLD_CHARS

        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        assert len(result) > 1

    def test_chunks_are_non_empty(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=15)
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.embedding_text.strip() != ""

    def test_all_content_is_represented_in_chunks(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=10)
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        # Every paragraph should appear in at least one chunk
        paragraphs = content.split("\n\n")
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            found = any(para in enriched.embedding_text for enriched in result)
            assert found, f"Paragraph not found in any chunk: {para[:50]}..."

    def test_chunk_sizes_within_reasonable_bounds(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=20, sentences_per_para=5)
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        for enriched in result:
            # No chunk should be excessively large (allow some tolerance for overlap)
            assert len(enriched.embedding_text) <= _TARGET_CHUNK_MAX_CHARS * 2


# ---------------------------------------------------------------------------
# Tests for TEXT element constraints (Requirements 3.2, 13.2, 13.3)
# ---------------------------------------------------------------------------


class TestTextConstraints:
    def test_topics_always_empty(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=10)
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.topics == []

    def test_labels_always_empty(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=10)
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.labels == []

    def test_keywords_always_empty(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=10)
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.keywords == []

    def test_short_text_also_has_empty_metadata(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="Short text.")
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].topics == []
        assert result[0].labels == []
        assert result[0].keywords == []


# ---------------------------------------------------------------------------
# Tests for EnrichedElement properties
# ---------------------------------------------------------------------------


class TestEnrichedElementProperties:
    def test_element_id_preserved(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(
            content="Some content", element_id="unique-id-123"
        )
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.element_id == "unique-id-123"

    def test_element_type_is_text(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="Content here.")
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.element_type == ElementType.TEXT

    def test_provenance_preserved(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="Content", page_num=5, position_index=3)
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.provenance.page_num == 5
            assert enriched.provenance.position_index == 3

    def test_enrichment_version_set(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="Some text.")
        result = chunker.enrich(element)

        for enriched in result:
            assert enriched.enrichment_version == ENRICHMENT_VERSION
            assert enriched.enrichment_version != ""

    def test_multi_chunk_all_share_element_id(self) -> None:
        chunker = TextChunker()
        content = _generate_long_text(num_paragraphs=15)
        element = _make_text_element(content=content, element_id="shared-id")
        result = chunker.enrich(element)

        assert len(result) > 1
        for enriched in result:
            assert enriched.element_id == "shared-id"


# ---------------------------------------------------------------------------
# Tests for edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_empty_string_produces_single_element(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="")
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == ""

    def test_whitespace_only_produces_single_element(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="   \n\n   \t   ")
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == ""

    def test_binary_content_decoded(self) -> None:
        chunker = TextChunker()
        element = IRElement(
            element_id="binary-el",
            content=b"Binary text content that should be decoded.",
            element_type=ElementType.TEXT,
            provenance=Provenance(page_num=1, position_index=0),
            content_hash="hash",
        )
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == "Binary text content that should be decoded."

    def test_single_very_long_paragraph_no_sentence_breaks(self) -> None:
        chunker = TextChunker()
        # A long paragraph without sentence-ending punctuation
        content = "word " * 2000  # ~10000 chars, no sentence breaks
        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        # Should still produce at least one element (may not split further)
        assert len(result) >= 1
        for enriched in result:
            assert enriched.embedding_text.strip() != ""

    def test_text_with_only_newlines(self) -> None:
        chunker = TextChunker()
        element = _make_text_element(content="\n\n\n\n")
        result = chunker.enrich(element)

        assert len(result) == 1
        assert result[0].embedding_text == ""

    def test_text_with_many_short_paragraphs(self) -> None:
        chunker = TextChunker()
        # Many short paragraphs that combined exceed threshold
        paragraphs = [f"Short paragraph number {i}." for i in range(200)]
        content = "\n\n".join(paragraphs)
        assert len(content) > _SINGLE_CHUNK_THRESHOLD_CHARS

        element = _make_text_element(content=content)
        result = chunker.enrich(element)

        # Should produce multiple chunks
        assert len(result) > 1
        # All should be TEXT with empty metadata
        for enriched in result:
            assert enriched.element_type == ElementType.TEXT
            assert enriched.topics == []
            assert enriched.labels == []
            assert enriched.keywords == []


# ---------------------------------------------------------------------------
# Tests for helper functions
# ---------------------------------------------------------------------------


class TestHelperFunctions:
    def test_split_into_paragraphs_basic(self) -> None:
        text = "Para one.\n\nPara two.\n\nPara three."
        result = _split_into_paragraphs(text)
        assert result == ["Para one.", "Para two.", "Para three."]

    def test_split_into_paragraphs_with_extra_whitespace(self) -> None:
        text = "Para one.\n\n\n\nPara two.\n  \n  \nPara three."
        result = _split_into_paragraphs(text)
        assert result == ["Para one.", "Para two.", "Para three."]

    def test_split_into_paragraphs_empty_string(self) -> None:
        result = _split_into_paragraphs("")
        assert result == []

    def test_split_into_sentences_basic(self) -> None:
        text = "First sentence. Second sentence. Third sentence."
        result = _split_into_sentences(text)
        assert result == ["First sentence.", "Second sentence.", "Third sentence."]

    def test_split_into_sentences_question_and_exclamation(self) -> None:
        text = "Is this a question? Yes it is! And this is a statement."
        result = _split_into_sentences(text)
        assert result == ["Is this a question?", "Yes it is!", "And this is a statement."]

    def test_split_into_sentences_single_sentence(self) -> None:
        text = "Just one sentence."
        result = _split_into_sentences(text)
        assert result == ["Just one sentence."]
