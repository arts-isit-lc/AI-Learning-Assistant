"""Adapter for image files (PNG, JPEG, GIF, TIFF, BMP, WebP).

Produces a single IMAGE RawElement per file containing the raw image bytes.
No size filtering is applied here — that is only for embedded images in
multi-page documents (e.g., PDF).
"""

from __future__ import annotations

from aws_lambda_powertools import Logger

from ...models.data_models import ElementType, FileMetadata, Provenance, RawElement
from ..base_adapter import BaseAdapter
from ..exceptions import ExtractionFailureError

logger = Logger(service="multimodal-rag-ingestion")


class ImageAdapter(BaseAdapter):
    """Extracts a single IMAGE element from standalone image files."""

    SUPPORTED_EXTENSIONS = {"png", "jpeg", "jpg", "gif", "tiff", "tif", "bmp", "webp"}

    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract a single IMAGE element from image file bytes.

        Args:
            file_content: Raw bytes of the image file.
            file_metadata: Metadata about the uploaded file.

        Returns:
            A list containing one RawElement with element_type=IMAGE.

        Raises:
            ExtractionFailureError: If the file content is empty or unreadable.
        """
        if not file_content:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="Image file is empty (zero bytes)",
            )

        logger.info(
            "Extracting image element",
            extra={
                "file_key": file_metadata.file_key,
                "file_size": len(file_content),
                "extension": file_metadata.extension,
            },
        )

        element = RawElement(
            content=file_content,
            element_type=ElementType.IMAGE,
            provenance=Provenance(page_num=1, position_index=0),
            raw_metadata={"source_format": file_metadata.extension},
        )

        return [element]
