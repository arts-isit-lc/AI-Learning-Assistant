"""Abstract base class for format-specific file adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models.data_models import FileMetadata, RawElement


class BaseAdapter(ABC):
    """Parse a file into raw content elements. NO AI/LLM calls allowed."""

    @abstractmethod
    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract raw elements from a file.

        Args:
            file_content: Raw bytes of the uploaded file.
            file_metadata: Metadata about the file (key, course, module, etc.).

        Returns:
            List of RawElement instances with provenance information.

        Raises:
            ExtractionFailureError: If extraction fails completely for the file.
        """
        ...
