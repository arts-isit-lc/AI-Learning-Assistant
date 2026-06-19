"""ElementRouter dispatches IRElements to the appropriate enrichment service.

Implements Requirements 3.1, 3.6, 3.7, 3.8, 3.9:
- Routes elements by type (TEXT→TextChunker, IMAGE→VisionService, FORMULA→FormulaService, TABLE→TableService)
- Produces fallback EnrichedElement on enrichment failure
- Retries with exponential backoff on Bedrock throttling (1s, 2s, 4s — max 3 retries)
- Enforces visual cap of 30 vision LLM calls per document
- Tags every EnrichedElement with current enrichment_version
"""

from __future__ import annotations

import time
from typing import Protocol

from aws_lambda_powertools import Logger

from ..models.data_models import (
    DocumentIR,
    ElementType,
    EnrichedElement,
    ENRICHMENT_VERSION,
    IRElement,
)

logger = Logger(service="multimodal-rag-enrichment")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

VISUAL_CAP: int = 30
BACKOFF_INITIAL_DELAY: float = 1.0
BACKOFF_MULTIPLIER: float = 2.0
MAX_RETRIES: int = 3


# ---------------------------------------------------------------------------
# Service Protocols (dependency injection contracts)
# ---------------------------------------------------------------------------


class TextChunkerProtocol(Protocol):
    """Protocol for the TextChunker service."""

    def enrich(self, element: IRElement) -> list[EnrichedElement]:
        """Enrich a TEXT element into one or more EnrichedElements (semantic chunks)."""
        ...


class VisionServiceProtocol(Protocol):
    """Protocol for the VisionService."""

    def enrich(self, element: IRElement) -> EnrichedElement:
        """Enrich an IMAGE element using vision LLM."""
        ...


class FormulaServiceProtocol(Protocol):
    """Protocol for the FormulaService."""

    def enrich(self, element: IRElement) -> EnrichedElement:
        """Enrich a FORMULA element (text-layer parse or vision fallback)."""
        ...


class TableServiceProtocol(Protocol):
    """Protocol for the TableService."""

    def enrich(self, element: IRElement) -> EnrichedElement:
        """Enrich a TABLE element with structured extraction."""
        ...


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_throttling_error(exc: Exception) -> bool:
    """Check if an exception is a Bedrock throttling error (HTTP 429 or ThrottlingException)."""
    exc_type_name = type(exc).__name__

    # botocore ClientError with ThrottlingException code
    if exc_type_name == "ClientError":
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
        if error_code in ("ThrottlingException", "TooManyRequestsException"):
            return True
        # Check HTTP status code
        http_status = (
            getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
        )
        if http_status == 429:
            return True

    # Direct ThrottlingException class name match
    if "Throttling" in exc_type_name or "TooManyRequests" in exc_type_name:
        return True

    return False


def _create_fallback(element: IRElement) -> EnrichedElement:
    """Create a fallback EnrichedElement when enrichment fails.

    Per Requirement 3.6: embedding_text = raw content string (or empty string for binary content).
    """
    if isinstance(element.content, str):
        embedding_text = element.content
    else:
        embedding_text = ""

    return EnrichedElement(
        element_id=element.element_id,
        element_type=element.element_type,
        provenance=element.provenance,
        embedding_text=embedding_text,
        enrichment_version=ENRICHMENT_VERSION,
    )


def _is_raster_formula(element: IRElement) -> bool:
    """Check if a FORMULA element is raster-only (content is bytes, requiring vision LLM)."""
    return element.element_type == ElementType.FORMULA and isinstance(element.content, bytes)


# ---------------------------------------------------------------------------
# ElementRouter
# ---------------------------------------------------------------------------


class ElementRouter:
    """Routes elements to correct enrichment service by element_type.

    Routing:
    - TEXT → TextChunker (no LLM, no topics/labels/keywords)
    - IMAGE → VisionService (Claude 3 Haiku vision)
    - FORMULA → FormulaService (text-layer parse or vision fallback)
    - TABLE → TableService (structured extraction)

    Handles fallback on failure and enforces visual cap (30 calls/document).
    Services are injected via constructor for testability.
    """

    def __init__(
        self,
        text_chunker: TextChunkerProtocol,
        vision_service: VisionServiceProtocol,
        formula_service: FormulaServiceProtocol,
        table_service: TableServiceProtocol,
    ) -> None:
        self._text_chunker = text_chunker
        self._vision_service = vision_service
        self._formula_service = formula_service
        self._table_service = table_service

    def enrich_document(self, document_ir: DocumentIR) -> list[EnrichedElement]:
        """Enrich all elements in a DocumentIR.

        Routes each IRElement to the correct service by element_type. Enforces:
        - Visual cap of 30 vision LLM calls per document (Req 3.8)
        - Exponential backoff on Bedrock throttling (Req 3.7)
        - Fallback enrichment on any failure (Req 3.6)
        - enrichment_version tagging on every output (Req 3.9)

        Args:
            document_ir: The intermediate representation to enrich.

        Returns:
            List of EnrichedElement instances for all elements.
            Failed elements receive fallback enrichment.
        """
        enriched_elements: list[EnrichedElement] = []
        vision_call_count: int = 0

        for element in document_ir.elements:
            try:
                results = self._enrich_element(element, vision_call_count)
                # Update vision call count based on what was processed
                if self._uses_vision(element):
                    vision_call_count += 1
                # Tag with enrichment_version and collect results
                for enriched in results:
                    enriched.enrichment_version = ENRICHMENT_VERSION
                enriched_elements.extend(results)
            except Exception:
                # Any unhandled error in the routing logic itself → fallback
                logger.exception(
                    "Unexpected error routing element",
                    extra={
                        "element_id": element.element_id,
                        "element_type": element.element_type.value,
                    },
                )
                fallback = _create_fallback(element)
                enriched_elements.append(fallback)

        logger.info(
            "Document enrichment complete",
            extra={
                "file_id": document_ir.file_metadata.file_id,
                "total_elements": len(document_ir.elements),
                "enriched_count": len(enriched_elements),
                "vision_calls": vision_call_count,
            },
        )
        return enriched_elements

    def _enrich_element(
        self, element: IRElement, vision_call_count: int
    ) -> list[EnrichedElement]:
        """Route a single element to its enrichment service with retry and fallback.

        Args:
            element: The IRElement to enrich.
            vision_call_count: Current count of vision LLM calls for this document.

        Returns:
            List of EnrichedElement(s) produced by the service (or fallback).
        """
        # Visual cap enforcement (Req 3.8)
        if self._uses_vision(element) and vision_call_count >= VISUAL_CAP:
            logger.info(
                "Visual cap reached, using fallback",
                extra={
                    "element_id": element.element_id,
                    "vision_call_count": vision_call_count,
                    "visual_cap": VISUAL_CAP,
                },
            )
            return [_create_fallback(element)]

        # Attempt enrichment with exponential backoff for throttling
        return self._enrich_with_backoff(element)

    def _enrich_with_backoff(self, element: IRElement) -> list[EnrichedElement]:
        """Attempt enrichment with exponential backoff on Bedrock throttling.

        Retry delays: 1s, 2s, 4s (initial=1s, multiplier=2x, max 3 retries).
        After max retries, produces fallback element.

        Args:
            element: The IRElement to enrich.

        Returns:
            List of EnrichedElement(s) from the service, or fallback on failure.
        """
        delay = BACKOFF_INITIAL_DELAY

        for attempt in range(MAX_RETRIES + 1):
            try:
                return self._dispatch(element)
            except Exception as exc:
                if _is_throttling_error(exc) and attempt < MAX_RETRIES:
                    logger.info(
                        "Bedrock throttling, retrying with backoff",
                        extra={
                            "element_id": element.element_id,
                            "attempt": attempt + 1,
                            "delay_seconds": delay,
                        },
                    )
                    time.sleep(delay)
                    delay *= BACKOFF_MULTIPLIER
                else:
                    # Non-throttling error or max retries exhausted → fallback
                    logger.exception(
                        "Enrichment failed, using fallback",
                        extra={
                            "element_id": element.element_id,
                            "element_type": element.element_type.value,
                            "attempt": attempt + 1,
                            "is_throttling": _is_throttling_error(exc),
                        },
                    )
                    return [_create_fallback(element)]

        # Should not reach here, but safety fallback
        return [_create_fallback(element)]  # pragma: no cover

    def _dispatch(self, element: IRElement) -> list[EnrichedElement]:
        """Dispatch element to the correct service based on element_type.

        Args:
            element: The IRElement to enrich.

        Returns:
            List of EnrichedElement(s) from the appropriate service.

        Raises:
            Any exception from the underlying service (handled by caller).
        """
        match element.element_type:
            case ElementType.TEXT:
                return self._text_chunker.enrich(element)
            case ElementType.IMAGE:
                result = self._vision_service.enrich(element)
                return [result]
            case ElementType.FORMULA:
                result = self._formula_service.enrich(element)
                return [result]
            case ElementType.TABLE:
                result = self._table_service.enrich(element)
                return [result]
            case _:
                logger.warning(
                    "Unknown element type, using fallback",
                    extra={
                        "element_id": element.element_id,
                        "element_type": str(element.element_type),
                    },
                )
                return [_create_fallback(element)]

    def _uses_vision(self, element: IRElement) -> bool:
        """Check if an element type uses the vision LLM (counts toward visual cap).

        IMAGE elements and raster FORMULA elements use vision LLM.
        """
        if element.element_type == ElementType.IMAGE:
            return True
        if _is_raster_formula(element):
            return True
        return False
