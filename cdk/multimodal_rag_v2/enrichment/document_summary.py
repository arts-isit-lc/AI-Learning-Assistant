"""DocumentSummaryGenerator: produces a DocumentSummary and RetrievalUnit for document-level retrieval.

Generates document-level summaries (topics, overview, learning objectives) from
document content and extracts structured metadata (title, lecture_number, week) from
filename patterns. Used for "What's in Lecture X?" queries.

Implements Requirements 5.1, 5.2, 5.3:
- Generate DocumentSummary with topics (3-10), overview (2-3 sentences), learning_objectives (1-5)
- Extract DocumentMetadata: title, lecture_number, week from filename patterns
- Create DocumentSummary RetrievalUnit with metadata: is_document_summary=true, title, lecture_number, week
- Set lecture_number/week to null when extraction fails
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from aws_lambda_powertools import Logger

from ..models.data_models import (
    DocumentIR,
    DocumentMetadata,
    DocumentSummary,
    ElementType,
    EMBEDDING_VERSION,
    ENRICHMENT_VERSION,
    Provenance,
    RetrievalUnit,
)

logger = Logger(service="multimodal-rag-enrichment")

# Claude Haiku 4.5 via Geo-US cross-Region inference (see enrichment version).
MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

# Maximum characters of text content to collect for summary generation
_MAX_CONTENT_CHARS = 2000

SUMMARY_PROMPT = """\
You are analyzing course material. Based on the following text content from a document, \
generate a JSON object with exactly these fields:
- "topics": an array of 3-10 key topics covered in the document
- "overview": a 2-3 sentence summary of what the document covers
- "learning_objectives": an array of 1-5 learning objectives a student would achieve

Return ONLY valid JSON, no other text.

Document content:
{content}"""


# ---------------------------------------------------------------------------
# Metadata extraction helpers
# ---------------------------------------------------------------------------

_LECTURE_PATTERN = re.compile(r"(?:lecture|lec)[\s_-]*(\d+)", re.IGNORECASE)
_WEEK_PATTERN = re.compile(r"(?:week|wk)[\s_-]*(\d+)", re.IGNORECASE)


def _extract_lecture_number(file_key: str) -> int | None:
    """Extract lecture number from file key using regex patterns.

    Matches patterns like: Lecture_7.pdf, lec-3.pptx, lecture 12.docx, Lec03.pdf
    """
    match = _LECTURE_PATTERN.search(file_key)
    if match:
        return int(match.group(1))
    return None


def _extract_week(file_key: str, module_id: str) -> int | None:
    """Extract week number from file key or module_id.

    Matches patterns like: week_3, Week-5, wk2
    """
    match = _WEEK_PATTERN.search(file_key)
    if match:
        return int(match.group(1))
    # Try module_id as fallback
    match = _WEEK_PATTERN.search(module_id)
    if match:
        return int(match.group(1))
    return None


def _extract_title(file_key: str) -> str | None:
    """Extract a human-readable title from the filename.

    Strips directory paths and extension, then cleans up underscores and dashes.
    Returns None if the resulting title is empty.
    """
    # Get just the filename from the path
    filename = file_key.rsplit("/", 1)[-1] if "/" in file_key else file_key

    # Remove extension
    if "." in filename:
        filename = filename.rsplit(".", 1)[0]

    # Clean up underscores, dashes, and extra whitespace
    title = filename.replace("_", " ").replace("-", " ")
    title = re.sub(r"\s+", " ", title).strip()

    return title if title else None


def _collect_text_content(document_ir: DocumentIR, max_chars: int = _MAX_CONTENT_CHARS) -> str:
    """Collect the first N characters of text content from the DocumentIR.

    Iterates through elements in order, collecting text from TEXT elements
    until the character limit is reached.
    """
    collected: list[str] = []
    total_chars = 0

    for element in document_ir.elements:
        if element.element_type == ElementType.TEXT:
            if isinstance(element.content, bytes):
                text = element.content.decode("utf-8", errors="replace")
            else:
                text = element.content

            text = text.strip()
            if not text:
                continue

            remaining = max_chars - total_chars
            if remaining <= 0:
                break

            if len(text) > remaining:
                text = text[:remaining]

            collected.append(text)
            total_chars += len(text)

    return "\n\n".join(collected)


def _generate_heuristic_summary(text_content: str, file_key: str) -> dict[str, Any]:
    """Generate a heuristic summary when Bedrock is unavailable.

    Extracts topics from first sentences and produces a basic overview.
    """
    # Extract potential topics from content (first few sentences)
    sentences = re.split(r"[.!?]\s+", text_content)
    sentences = [s.strip() for s in sentences if s.strip() and len(s.strip()) > 10]

    # Use first few meaningful sentences as topics
    topics = []
    for sentence in sentences[:5]:
        # Truncate long sentences to use as topic phrases
        topic = sentence[:80].strip()
        if topic:
            topics.append(topic)

    # Ensure minimum 3 topics
    if len(topics) < 3:
        title = _extract_title(file_key) or "Document"
        while len(topics) < 3:
            topics.append(f"Content from {title}")

    # Limit to 10 topics
    topics = topics[:10]

    # Build overview from first 2-3 sentences
    overview_sentences = sentences[:3] if len(sentences) >= 3 else sentences[:2]
    overview = ". ".join(overview_sentences)
    if overview and not overview.endswith("."):
        overview += "."
    if not overview:
        title = _extract_title(file_key) or "this document"
        overview = f"This document covers content from {title}."

    # Simple learning objectives
    learning_objectives = [f"Understand the key concepts in this document"]
    if len(sentences) > 3:
        learning_objectives.append("Review the main topics presented")

    return {
        "topics": topics,
        "overview": overview,
        "learning_objectives": learning_objectives,
    }


# ---------------------------------------------------------------------------
# DocumentSummaryGenerator
# ---------------------------------------------------------------------------


class DocumentSummaryGenerator:
    """Generates document-level summaries and RetrievalUnits.

    Uses Bedrock (Claude 3 Haiku) to generate a summary from document text content.
    Falls back to heuristic summary if Bedrock is unavailable.

    Extracts DocumentMetadata (title, lecture_number, week) from filename patterns.
    """

    def __init__(self, bedrock_client: Any = None) -> None:
        """Initialize DocumentSummaryGenerator.

        Args:
            bedrock_client: A boto3 Bedrock Runtime client instance.
                If None, heuristic summary will be used.
        """
        self._client = bedrock_client

    def generate(self, document_ir: DocumentIR) -> tuple[DocumentSummary, RetrievalUnit]:
        """Generate a DocumentSummary and corresponding RetrievalUnit.

        Collects text content from the DocumentIR, generates a summary
        (via Bedrock or heuristic fallback), extracts document metadata,
        and produces a RetrievalUnit suitable for document-level retrieval.

        Args:
            document_ir: The intermediate representation to summarize.

        Returns:
            A tuple of (DocumentSummary, RetrievalUnit).
        """
        file_key = document_ir.file_metadata.file_key
        file_id = document_ir.file_metadata.file_id
        module_id = document_ir.file_metadata.module_id

        # Collect text content for summary generation
        text_content = _collect_text_content(document_ir)

        # Generate summary (Bedrock or heuristic)
        summary_data = self._generate_summary(text_content, file_key)

        topics = summary_data.get("topics", [])[:10]
        if len(topics) < 3:
            # Pad to minimum 3 topics
            title = _extract_title(file_key) or "Document"
            while len(topics) < 3:
                topics.append(f"Content from {title}")

        overview = summary_data.get("overview", "")
        learning_objectives = summary_data.get("learning_objectives", [])[:5]
        if not learning_objectives:
            learning_objectives = ["Understand the key concepts in this document"]

        # Build DocumentSummary
        doc_summary = DocumentSummary(
            file_id=file_id,
            topics=topics,
            summary=overview,
            learning_objectives=learning_objectives,
            enrichment_version=ENRICHMENT_VERSION,
        )

        # Extract document metadata from filename
        doc_metadata = self._extract_metadata(document_ir)

        # Build RetrievalUnit for the summary
        retrieval_unit = self._build_retrieval_unit(doc_summary, doc_metadata)

        logger.info(
            "Document summary generated",
            extra={
                "file_id": file_id,
                "topic_count": len(doc_summary.topics),
                "lecture_number": doc_metadata.lecture_number,
                "week": doc_metadata.week,
            },
        )

        return doc_summary, retrieval_unit

    def _generate_summary(self, text_content: str, file_key: str) -> dict[str, Any]:
        """Generate summary using Bedrock or heuristic fallback.

        Args:
            text_content: Collected text from the document.
            file_key: The file key (used for heuristic fallback).

        Returns:
            Dict with keys: topics, overview, learning_objectives.
        """
        if not self._client:
            logger.info("No Bedrock client available, using heuristic summary")
            return _generate_heuristic_summary(text_content, file_key)

        if not text_content.strip():
            logger.info("No text content available, using heuristic summary")
            return _generate_heuristic_summary(text_content, file_key)

        try:
            return self._invoke_bedrock(text_content)
        except Exception:
            logger.exception("Bedrock invocation failed for document summary, using heuristic fallback")
            return _generate_heuristic_summary(text_content, file_key)

    def _invoke_bedrock(self, text_content: str) -> dict[str, Any]:
        """Invoke Claude 3 Haiku to generate a structured document summary.

        Args:
            text_content: The document text content to summarize.

        Returns:
            Parsed JSON dict with topics, overview, learning_objectives.

        Raises:
            Exception: On Bedrock invocation failure or response parsing error.
        """
        prompt = SUMMARY_PROMPT.format(content=text_content)

        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1024,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt,
                        }
                    ],
                }
            ],
        }

        response = self._client.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(request_body),
        )

        response_body = json.loads(response["body"].read())
        return self._parse_response(response_body)

    def _parse_response(self, response_body: dict[str, Any]) -> dict[str, Any]:
        """Extract JSON from Claude response content.

        Args:
            response_body: The parsed response from Bedrock.

        Returns:
            Parsed JSON dict with summary fields.

        Raises:
            ValueError: If the response cannot be parsed as JSON.
        """
        content_blocks = response_body.get("content", [])
        for block in content_blocks:
            if block.get("type") == "text":
                text = block["text"].strip()
                # Handle potential markdown code fences
                if text.startswith("```"):
                    lines = text.split("\n")
                    text = "\n".join(lines[1:-1]).strip()
                return json.loads(text)

        raise ValueError("No text content in summary model response")

    def _extract_metadata(self, document_ir: DocumentIR) -> DocumentMetadata:
        """Extract structured metadata from the document filename/path.

        Args:
            document_ir: The DocumentIR to extract metadata from.

        Returns:
            DocumentMetadata with title, lecture_number, week (nullable).
        """
        file_key = document_ir.file_metadata.file_key
        file_id = document_ir.file_metadata.file_id
        module_id = document_ir.file_metadata.module_id

        title = _extract_title(file_key)
        lecture_number = _extract_lecture_number(file_key)
        week = _extract_week(file_key, module_id)

        return DocumentMetadata(
            file_id=file_id,
            title=title,
            lecture_number=lecture_number,
            week=week,
            module_name=module_id,
            source_type=document_ir.file_metadata.extension,
            page_count=len(document_ir.elements),
        )

    def _build_retrieval_unit(
        self,
        doc_summary: DocumentSummary,
        doc_metadata: DocumentMetadata,
    ) -> RetrievalUnit:
        """Build a RetrievalUnit for the DocumentSummary.

        Creates a RetrievalUnit with metadata that enables:
        - is_document_summary=true filtering
        - lecture_number exact-match filtering
        - week exact-match filtering
        - title for display

        Args:
            doc_summary: The generated document summary.
            doc_metadata: Extracted document metadata.

        Returns:
            A RetrievalUnit configured for document-level retrieval.
        """
        retrieval_id = str(uuid.uuid4())
        parent_element_id = f"summary-{doc_summary.file_id}"

        # Build embedding text from summary overview + topics
        embedding_text = doc_summary.summary
        if doc_summary.topics:
            embedding_text += " Topics: " + ", ".join(doc_summary.topics)

        metadata = {
            "is_document_summary": True,
            "title": doc_metadata.title,
            "lecture_number": doc_metadata.lecture_number,
            "week": doc_metadata.week,
        }

        return RetrievalUnit(
            retrieval_id=retrieval_id,
            parent_element_id=parent_element_id,
            embedding_text=embedding_text,
            element_type=ElementType.TEXT,
            provenance=Provenance(page_num=0),
            metadata=metadata,
            sibling_ids=[],
            embedding_version=EMBEDDING_VERSION,
        )
