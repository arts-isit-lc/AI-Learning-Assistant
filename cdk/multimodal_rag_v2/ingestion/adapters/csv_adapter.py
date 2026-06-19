"""Adapter for CSV files.

Extracts the entire CSV content as a single TABLE element.
Uses Python's built-in csv module — no AI/LLM calls.
"""

from __future__ import annotations

import csv
import io

from aws_lambda_powertools import Logger

from ...models.data_models import ElementType, FileMetadata, Provenance, RawElement
from ..base_adapter import BaseAdapter
from ..exceptions import ExtractionFailureError

logger = Logger(service="multimodal-rag-ingestion")


class CsvAdapter(BaseAdapter):
    """Extracts a single TABLE element from CSV files."""

    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract the CSV content as a single TABLE element.

        Args:
            file_content: Raw bytes of the CSV file.
            file_metadata: Metadata about the uploaded file.

        Returns:
            A list containing one RawElement with element_type=TABLE.

        Raises:
            ExtractionFailureError: If the CSV file is empty or cannot be parsed.
        """
        if not file_content:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="CSV file is empty (zero bytes)",
            )

        try:
            csv_text = file_content.decode("utf-8", errors="replace")
        except Exception as exc:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"Failed to decode CSV file: {exc}",
            ) from exc

        if not csv_text.strip():
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="CSV file contains no content after decoding",
            )

        # Validate it's parseable as CSV
        try:
            reader = csv.reader(io.StringIO(csv_text))
            rows = list(reader)
        except csv.Error as exc:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"CSV parsing failed: {exc}",
            ) from exc

        if not rows:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="CSV file contains no rows",
            )

        logger.info(
            "Extracting CSV as table element",
            extra={
                "file_key": file_metadata.file_key,
                "row_count": len(rows),
                "column_count": len(rows[0]) if rows else 0,
            },
        )

        # Store the raw CSV text as the content for downstream processing
        element = RawElement(
            content=csv_text,
            element_type=ElementType.TABLE,
            provenance=Provenance(page_num=1, position_index=0),
            raw_metadata={
                "row_count": len(rows),
                "column_count": len(rows[0]) if rows else 0,
                "has_header": True,  # Assume first row is header by convention
            },
        )

        return [element]
