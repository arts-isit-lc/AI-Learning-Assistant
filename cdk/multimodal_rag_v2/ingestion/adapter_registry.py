"""Registry that dispatches files to format-specific adapters by extension."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from .base_adapter import BaseAdapter
from .exceptions import FileSizeExceededError, UnsupportedFormatError

if TYPE_CHECKING:
    from ..models.data_models import FileMetadata, RawElement

# Maximum allowed file size: 200 MB
MAX_FILE_SIZE_BYTES: int = 200 * 1024 * 1024


class AdapterRegistry:
    """Routes files to the appropriate adapter based on file extension.

    Also enforces the 200 MB file size limit before extraction begins.
    """

    def __init__(self) -> None:
        self._adapters: dict[str, BaseAdapter] = {}

    def register(self, extensions: list[str], adapter: BaseAdapter) -> None:
        """Register an adapter for one or more file extensions.

        Args:
            extensions: List of file extensions (without dot, e.g. ["pdf"]).
            adapter: The adapter instance to handle these extensions.
        """
        for ext in extensions:
            self._adapters[ext.lower()] = adapter

    def get_adapter(self, file_key: str) -> BaseAdapter:
        """Get the adapter for a given file key based on its extension.

        Args:
            file_key: The S3 key or filename of the uploaded file.

        Returns:
            The registered adapter for the file's extension.

        Raises:
            UnsupportedFormatError: If the extension is unsupported or missing.
        """
        _, ext = os.path.splitext(file_key)
        if not ext:
            raise UnsupportedFormatError(extension="", file_key=file_key)

        ext_lower = ext.lstrip(".").lower()
        adapter = self._adapters.get(ext_lower)
        if adapter is None:
            raise UnsupportedFormatError(extension=ext_lower, file_key=file_key)

        return adapter

    def validate_file_size(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> None:
        """Validate that file size does not exceed the 200 MB limit.

        Uses file_metadata.file_size when available (trusted metadata from S3),
        falling back to len(file_content) for in-memory validation.

        Args:
            file_content: Raw bytes of the uploaded file.
            file_metadata: Metadata about the file.

        Raises:
            FileSizeExceededError: If the file exceeds 200 MB.
        """
        file_size = file_metadata.file_size or len(file_content)
        if file_size > MAX_FILE_SIZE_BYTES:
            raise FileSizeExceededError(
                file_size_bytes=file_size, file_key=file_metadata.file_key
            )

    def process_file(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Validate file size, resolve adapter, and extract content.

        This is the primary entry point for ingestion. It enforces the 200 MB
        file size limit BEFORE any extraction begins, then routes to the
        appropriate adapter based on file extension.

        Args:
            file_content: Raw bytes of the uploaded file.
            file_metadata: Metadata about the file (includes file_key, extension).

        Returns:
            List of RawElement instances extracted by the adapter.

        Raises:
            FileSizeExceededError: If the file exceeds 200 MB.
            UnsupportedFormatError: If the file extension is unsupported or missing.
            ExtractionFailureError: If the adapter fails to extract content.
        """
        # Step 1: Enforce file size limit before any extraction
        self.validate_file_size(file_content, file_metadata)

        # Step 2: Get the adapter for this file's extension
        adapter = self.get_adapter(file_metadata.file_key)

        # Step 3: Extract content via the adapter
        return adapter.extract(file_content, file_metadata)
