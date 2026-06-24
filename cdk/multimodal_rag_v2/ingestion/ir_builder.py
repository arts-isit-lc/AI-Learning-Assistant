"""IRBuilder normalizes raw adapter output into a DocumentIR."""

from __future__ import annotations

import hashlib
from collections import Counter

from aws_lambda_powertools import Logger

from ..models.data_models import (
    DocumentIR,
    ElementType,
    FileMetadata,
    IRElement,
    IR_VERSION,
    Provenance,
    RawElement,
)
from .exceptions import ExtractionFailureError

logger = Logger(service="multimodal-rag-ingestion")

# Minimum image dimensions (pixels) — images below this threshold are filtered out.
_MIN_IMAGE_WIDTH = 100
_MIN_IMAGE_HEIGHT = 100


class IRBuilder:
    """Normalizes adapter output into DocumentIR with deduplication and ordering.

    Responsibilities:
    - Assign element_id = SHA256(content + provenance)
    - Assign content_hash = SHA256(content) for deduplication
    - Deduplicate elements by content_hash (first occurrence wins)
    - Sort elements by provenance order (page_num, position_index)
    - Filter images smaller than 100x100 pixels
    """

    def build(
        self, raw_elements: list[RawElement], file_metadata: FileMetadata
    ) -> DocumentIR:
        """Build a DocumentIR from raw elements.

        Args:
            raw_elements: List of RawElement extracted by an adapter.
            file_metadata: Metadata about the source file.

        Returns:
            A DocumentIR instance with deduplicated, ordered elements.

        Raises:
            ExtractionFailureError: If building fails completely.
        """
        try:
            return self._build_ir(raw_elements, file_metadata)
        except ExtractionFailureError:
            raise
        except Exception as e:
            logger.exception("Complete extraction failure during IR build")
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=str(e),
            ) from e

    def _build_ir(
        self, raw_elements: list[RawElement], file_metadata: FileMetadata
    ) -> DocumentIR:
        """Internal build logic — produces the DocumentIR."""
        seen_hashes: set[str] = set()
        elements: list[IRElement] = []
        dedup_count = 0
        filtered_small_count = 0

        for raw in raw_elements:
            # Filter small images
            if raw.element_type == ElementType.IMAGE and self._is_small_image(raw):
                filtered_small_count += 1
                continue

            # Compute content bytes for hashing
            content_bytes = self._get_content_bytes(raw.content)

            # content_hash for deduplication
            content_hash = hashlib.sha256(content_bytes).hexdigest()

            # Deduplicate: first occurrence wins
            if content_hash in seen_hashes:
                dedup_count += 1
                continue
            seen_hashes.add(content_hash)

            # element_id = SHA256(content_bytes + provenance_str)
            provenance_str = self._provenance_to_str(raw.provenance)
            element_id = hashlib.sha256(
                content_bytes + provenance_str.encode("utf-8")
            ).hexdigest()

            ir_element = IRElement(
                element_id=element_id,
                content=raw.content,
                element_type=raw.element_type,
                provenance=raw.provenance,
                content_hash=content_hash,
                metadata=raw.raw_metadata.copy() if raw.raw_metadata else {},
            )
            elements.append(ir_element)

        # Sort by provenance order: (page_num, slide_num, position_index)
        elements.sort(key=self._sort_key)

        # Compute element_count by ElementType
        type_counter: Counter[ElementType] = Counter()
        for el in elements:
            type_counter[el.element_type] += 1

        element_count = dict(type_counter)

        # Determine max page for diagnostics
        max_page = max(
            (el.provenance.page_num or 0 for el in elements), default=0
        )

        logger.info(
            "IR build summary",
            extra={
                "file_id": file_metadata.file_id,
                "file_key": file_metadata.file_key,
                "raw_element_count": len(raw_elements),
                "final_element_count": len(elements),
                "deduplicated_count": dedup_count,
                "filtered_small_images": filtered_small_count,
                "element_type_breakdown": {k.value: v for k, v in element_count.items()},
                "max_page_number": max_page,
                "ir_version": IR_VERSION,
            },
        )

        return DocumentIR(
            file_metadata=file_metadata,
            elements=elements,
            element_count=element_count,
            ir_version=IR_VERSION,
        )

    @staticmethod
    def _get_content_bytes(content: bytes | str) -> bytes:
        """Convert content to bytes for hashing."""
        if isinstance(content, bytes):
            return content
        return content.encode("utf-8")

    @staticmethod
    def _provenance_to_str(provenance: Provenance) -> str:
        """Produce a stable string representation of provenance for hashing."""
        return (
            f"{provenance.page_num}:{provenance.slide_num}"
            f":{provenance.section}:{provenance.position_index}"
        )

    @staticmethod
    def _is_small_image(raw: RawElement) -> bool:
        """Check if an image element is below the minimum size threshold."""
        width = raw.raw_metadata.get("width")
        height = raw.raw_metadata.get("height")
        if width is None or height is None:
            # If dimensions aren't available, don't filter
            return False
        return width < _MIN_IMAGE_WIDTH or height < _MIN_IMAGE_HEIGHT

    @staticmethod
    def _sort_key(element: IRElement) -> tuple[int, int, int]:
        """Sort key based on provenance: (page_num, slide_num, position_index)."""
        return (
            element.provenance.page_num or 0,
            element.provenance.slide_num or 0,
            element.provenance.position_index,
        )
