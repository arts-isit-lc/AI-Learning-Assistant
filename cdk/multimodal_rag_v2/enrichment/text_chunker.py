"""TextChunker performs semantic chunking of TEXT elements without any LLM calls.

Produces one or more EnrichedElements per IRElement by splitting text into
semantically meaningful chunks based on paragraph/sentence boundaries.

Hard requirements:
- NO LLM calls (Requirement 13.2)
- topics, labels, keywords ALWAYS empty for TEXT elements (Requirement 13.3)
- Produces EnrichedElement(s) with embedding_text from chunked content (Requirement 3.2)
"""

from __future__ import annotations

import re

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    IRElement,
)

logger = Logger(service="multimodal-rag-enrichment")

# Chunking configuration
# ~4 chars per token approximation
_CHARS_PER_TOKEN = 4
_TARGET_CHUNK_MIN_TOKENS = 500
_TARGET_CHUNK_MAX_TOKENS = 1000
_TARGET_CHUNK_MIN_CHARS = _TARGET_CHUNK_MIN_TOKENS * _CHARS_PER_TOKEN  # 2000
_TARGET_CHUNK_MAX_CHARS = _TARGET_CHUNK_MAX_TOKENS * _CHARS_PER_TOKEN  # 4000
_SINGLE_CHUNK_THRESHOLD_TOKENS = 1000
_SINGLE_CHUNK_THRESHOLD_CHARS = _SINGLE_CHUNK_THRESHOLD_TOKENS * _CHARS_PER_TOKEN  # 4000
_OVERLAP_SENTENCES = 1  # number of sentences to overlap between chunks


def _split_into_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs using double newlines or multiple whitespace lines."""
    paragraphs = re.split(r"\n\s*\n", text)
    return [p.strip() for p in paragraphs if p.strip()]


def _split_into_sentences(text: str) -> list[str]:
    """Split text into sentences using common sentence-ending punctuation."""
    # Split on sentence boundaries: period/question/exclamation followed by space or end
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return [s.strip() for s in sentences if s.strip()]


def _merge_paragraphs_into_chunks(
    paragraphs: list[str],
) -> list[str]:
    """Merge paragraphs into chunks respecting size limits with sentence-level overlap.

    Strategy:
    - Accumulate paragraphs until chunk exceeds target max chars
    - When a paragraph would push beyond max, finalize current chunk
    - Apply overlap: last sentence of previous chunk repeated at start of next
    """
    if not paragraphs:
        return []

    chunks: list[str] = []
    current_parts: list[str] = []
    current_len = 0

    for paragraph in paragraphs:
        para_len = len(paragraph)

        # If adding this paragraph exceeds max and we already have content, finalize
        if current_len + para_len > _TARGET_CHUNK_MAX_CHARS and current_parts:
            chunk_text = "\n\n".join(current_parts)
            chunks.append(chunk_text)

            # Overlap: get last sentence from current chunk for continuity
            overlap_text = _get_overlap_text(current_parts)
            current_parts = []
            current_len = 0

            if overlap_text:
                current_parts.append(overlap_text)
                current_len = len(overlap_text)

        current_parts.append(paragraph)
        current_len += para_len

    # Don't forget the last chunk
    if current_parts:
        chunk_text = "\n\n".join(current_parts)
        chunks.append(chunk_text)

    return chunks


def _get_overlap_text(parts: list[str]) -> str:
    """Extract the last N sentences from the chunk parts for overlap."""
    if not parts:
        return ""

    # Get the last paragraph's sentences
    last_part = parts[-1]
    sentences = _split_into_sentences(last_part)

    if not sentences:
        return ""

    # Take last _OVERLAP_SENTENCES sentence(s) as overlap
    overlap_sentences = sentences[-_OVERLAP_SENTENCES:]
    return " ".join(overlap_sentences)


class TextChunker:
    """Semantic text chunker that produces EnrichedElements without LLM calls.

    Chunking strategy:
    - If text is short enough (< 1000 tokens / ~4000 chars), produce a single chunk
    - Otherwise split into paragraphs, then merge paragraphs into chunks of
      ~500-1000 tokens with small sentence overlap for continuity
    - Uses paragraph boundaries as natural semantic break points
    """

    def enrich(self, element: IRElement) -> list[EnrichedElement]:
        """Chunk a TEXT IRElement into one or more EnrichedElements.

        Args:
            element: The TEXT IRElement to chunk.

        Returns:
            List of EnrichedElements with embedding_text from chunked content.
            topics, labels, keywords are ALWAYS empty for TEXT elements.
        """
        # Extract text content
        if isinstance(element.content, bytes):
            text = element.content.decode("utf-8", errors="replace")
        else:
            text = element.content

        text = text.strip()

        # Empty or whitespace-only text produces a single element with empty embedding_text
        if not text:
            logger.warning(
                "TEXT element has empty content",
                extra={"element_id": element.element_id},
            )
            return [
                self._build_enriched_element(
                    element=element,
                    embedding_text="",
                )
            ]

        # Short text: produce a single chunk
        if len(text) <= _SINGLE_CHUNK_THRESHOLD_CHARS:
            logger.debug(
                "TEXT element fits in single chunk",
                extra={
                    "element_id": element.element_id,
                    "char_count": len(text),
                },
            )
            return [
                self._build_enriched_element(
                    element=element,
                    embedding_text=text,
                )
            ]

        # Longer text: split into semantic chunks
        paragraphs = _split_into_paragraphs(text)

        # If paragraph splitting didn't help (single giant paragraph), fall back to sentence splitting
        if len(paragraphs) <= 1:
            paragraphs = _split_into_sentences(text)

        # If still a single block, just return it as-is (unlikely but handles edge case)
        if len(paragraphs) <= 1:
            return [
                self._build_enriched_element(
                    element=element,
                    embedding_text=text,
                )
            ]

        chunks = _merge_paragraphs_into_chunks(paragraphs)

        logger.debug(
            "TEXT element chunked",
            extra={
                "element_id": element.element_id,
                "char_count": len(text),
                "chunk_count": len(chunks),
            },
        )

        # Produce one EnrichedElement per chunk
        enriched_elements: list[EnrichedElement] = []
        for chunk_text in chunks:
            if chunk_text.strip():  # skip empty chunks
                enriched_elements.append(
                    self._build_enriched_element(
                        element=element,
                        embedding_text=chunk_text,
                    )
                )

        # If all chunks were empty (shouldn't happen but safety check), return single element
        if not enriched_elements:
            return [
                self._build_enriched_element(
                    element=element,
                    embedding_text=text,
                )
            ]

        return enriched_elements

    def _build_enriched_element(
        self,
        element: IRElement,
        embedding_text: str,
    ) -> EnrichedElement:
        """Build an EnrichedElement for a TEXT chunk.

        Always sets topics, labels, keywords to empty lists per Requirements 3.2, 13.2, 13.3.
        """
        return EnrichedElement(
            element_id=element.element_id,
            element_type=ElementType.TEXT,
            provenance=element.provenance,
            embedding_text=embedding_text,
            topics=[],  # ALWAYS empty for TEXT
            labels=[],  # ALWAYS empty for TEXT
            keywords=[],  # ALWAYS empty for TEXT
            enrichment_version=ENRICHMENT_VERSION,
        )
