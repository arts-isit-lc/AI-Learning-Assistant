"""Adapter for JSON files.

Detects the structure of JSON content:
- If it's an array of objects with consistent keys → TABLE element
- Otherwise → TEXT element (JSON stringified)

Uses Python's built-in json module — no AI/LLM calls.
"""

from __future__ import annotations

import json

from aws_lambda_powertools import Logger

from ...models.data_models import ElementType, FileMetadata, Provenance, RawElement
from ..base_adapter import BaseAdapter
from ..exceptions import ExtractionFailureError

logger = Logger(service="multimodal-rag-ingestion")


class JsonAdapter(BaseAdapter):
    """Extracts TEXT or TABLE elements from JSON files based on structure."""

    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract elements from a JSON file.

        If the JSON is an array of objects with consistent keys, it is
        treated as a TABLE. Otherwise, the JSON is serialized as a TEXT element.

        Args:
            file_content: Raw bytes of the JSON file.
            file_metadata: Metadata about the uploaded file.

        Returns:
            A list containing one RawElement (TABLE or TEXT type).

        Raises:
            ExtractionFailureError: If the JSON file is empty or invalid.
        """
        if not file_content:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="JSON file is empty (zero bytes)",
            )

        try:
            json_text = file_content.decode("utf-8", errors="replace")
        except Exception as exc:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"Failed to decode JSON file: {exc}",
            ) from exc

        if not json_text.strip():
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="JSON file contains no content after decoding",
            )

        try:
            data = json.loads(json_text)
        except json.JSONDecodeError as exc:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"Invalid JSON: {exc}",
            ) from exc

        if self._is_tabular(data):
            return self._extract_as_table(data, json_text, file_metadata)
        else:
            return self._extract_as_text(data, json_text, file_metadata)

    def _is_tabular(self, data: object) -> bool:
        """Determine if the JSON structure is tabular (array of objects with consistent keys).

        Returns True if:
        - data is a non-empty list
        - all items are dicts
        - all dicts share at least one common key
        """
        if not isinstance(data, list) or len(data) == 0:
            return False

        if not all(isinstance(item, dict) for item in data):
            return False

        # Check for consistent keys: all items must have the same set of keys
        first_keys = set(data[0].keys())
        if not first_keys:
            return False

        # Allow some flexibility: check that all items share a common key set
        common_keys = first_keys
        for item in data[1:]:
            common_keys = common_keys & set(item.keys())
            if not common_keys:
                return False

        return True

    def _extract_as_table(
        self, data: list[dict], json_text: str, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract tabular JSON as a TABLE element."""
        logger.info(
            "Extracting JSON as table element",
            extra={
                "file_key": file_metadata.file_key,
                "row_count": len(data),
                "column_count": len(data[0].keys()) if data else 0,
            },
        )

        element = RawElement(
            content=json_text,
            element_type=ElementType.TABLE,
            provenance=Provenance(page_num=1, position_index=0),
            raw_metadata={
                "row_count": len(data),
                "column_count": len(data[0].keys()) if data else 0,
                "structure": "array_of_objects",
            },
        )

        return [element]

    def _extract_as_text(
        self, data: object, json_text: str, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract non-tabular JSON as a TEXT element."""
        logger.info(
            "Extracting JSON as text element",
            extra={
                "file_key": file_metadata.file_key,
                "data_type": type(data).__name__,
            },
        )

        # Use pretty-printed JSON for better readability as text
        content = json.dumps(data, indent=2, ensure_ascii=False)

        element = RawElement(
            content=content,
            element_type=ElementType.TEXT,
            provenance=Provenance(page_num=1, position_index=0),
            raw_metadata={
                "structure": "non_tabular",
                "data_type": type(data).__name__,
            },
        )

        return [element]
