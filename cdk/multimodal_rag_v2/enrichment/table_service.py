"""TableService: Structured table extraction without LLM calls.

Extracts table_headers, table_rows, and generates a heuristic table_summary.
Supports tab-separated, comma-separated, and pipe-separated table formats.
"""

from __future__ import annotations

import csv
import io
import re

from aws_lambda_powertools import Logger

from ..models.data_models import (
    ENRICHMENT_VERSION,
    ElementType,
    EnrichedElement,
    IRElement,
)

logger = Logger(service="multimodal-rag-enrichment")


class TableService:
    """Extracts structured table data without LLM calls.

    Parses table content in various formats (tab-separated, CSV,
    pipe-separated) and generates a simple heuristic summary.
    """

    def enrich(self, element: IRElement) -> EnrichedElement:
        """Enrich a TABLE element with structured extraction.

        Args:
            element: An IRElement with element_type=TABLE containing
                     table data as string content.

        Returns:
            EnrichedElement with table_headers, table_rows, table_summary,
            and embedding_text containing the full table representation.

        Raises:
            Exception: On parsing failure. ElementRouter handles fallback.
        """
        content = element.content if isinstance(element.content, str) else element.content.decode("utf-8")

        rows = self._parse_table(content)

        if not rows:
            logger.info(
                "Empty table content",
                extra={"element_id": element.element_id},
            )
            return EnrichedElement(
                element_id=element.element_id,
                element_type=ElementType.TABLE,
                provenance=element.provenance,
                embedding_text="Empty table",
                table_headers=[],
                table_rows=[],
                table_summary="Empty table with no data.",
                enrichment_version=ENRICHMENT_VERSION,
            )

        # First row is treated as headers
        table_headers = rows[0]
        table_rows = rows[1:]

        table_summary = self._generate_summary(table_headers, table_rows)

        # Build full embedding_text with caption (if present), headers, and all row data
        # This ensures the actual data values are searchable and available in context
        embedding_text = self._build_full_embedding_text(content, table_headers, table_rows, table_summary)

        logger.info(
            "Extracted table structure",
            extra={
                "element_id": element.element_id,
                "headers_count": len(table_headers),
                "rows_count": len(table_rows),
                "embedding_text_length": len(embedding_text),
            },
        )

        return EnrichedElement(
            element_id=element.element_id,
            element_type=ElementType.TABLE,
            provenance=element.provenance,
            embedding_text=embedding_text,
            table_headers=table_headers,
            table_rows=table_rows,
            table_summary=table_summary,
            enrichment_version=ENRICHMENT_VERSION,
        )

    def _parse_table(self, content: str) -> list[list[str]]:
        """Parse table content, auto-detecting the delimiter format.

        Supports:
        - Pipe-separated (Markdown tables)
        - Tab-separated (TSV)
        - Comma-separated (CSV)

        Args:
            content: Raw table content string.

        Returns:
            List of rows, where each row is a list of cell values.
        """
        content = content.strip()
        if not content:
            return []

        # Detect pipe-separated (Markdown table format)
        if "|" in content:
            return self._parse_pipe_separated(content)

        # Detect tab-separated
        if "\t" in content:
            return self._parse_tsv(content)

        # Default to CSV
        return self._parse_csv(content)

    def _parse_pipe_separated(self, content: str) -> list[list[str]]:
        """Parse Markdown-style pipe-separated tables.

        Args:
            content: Pipe-separated table content.

        Returns:
            Parsed rows as list of lists.
        """
        rows: list[list[str]] = []
        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            # Skip separator lines (e.g., |---|---|---|)
            if re.match(r"^\|?[\s\-:]+(\|[\s\-:]+)*\|?$", line):
                continue
            # Split by pipe and clean cells
            cells = [cell.strip() for cell in line.split("|")]
            # Remove empty first/last cells from leading/trailing pipes
            if cells and cells[0] == "":
                cells = cells[1:]
            if cells and cells[-1] == "":
                cells = cells[:-1]
            if cells:
                rows.append(cells)
        return rows

    def _parse_tsv(self, content: str) -> list[list[str]]:
        """Parse tab-separated values.

        Args:
            content: Tab-separated table content.

        Returns:
            Parsed rows as list of lists.
        """
        rows: list[list[str]] = []
        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            cells = [cell.strip() for cell in line.split("\t")]
            rows.append(cells)
        return rows

    def _parse_csv(self, content: str) -> list[list[str]]:
        """Parse comma-separated values using the csv module.

        Args:
            content: CSV table content.

        Returns:
            Parsed rows as list of lists.
        """
        rows: list[list[str]] = []
        reader = csv.reader(io.StringIO(content))
        for row in reader:
            cleaned = [cell.strip() for cell in row]
            if any(cell for cell in cleaned):  # Skip fully empty rows
                rows.append(cleaned)
        return rows

    def _generate_summary(self, headers: list[str], rows: list[list[str]]) -> str:
        """Generate a heuristic table summary (1-3 sentences).

        Args:
            headers: Column header names.
            rows: Data rows (excluding header).

        Returns:
            A short summary describing the table structure and content.
        """
        num_rows = len(rows)
        num_cols = len(headers)
        headers_str = ", ".join(headers[:5])
        if len(headers) > 5:
            headers_str += f", and {len(headers) - 5} more"

        summary = f"Table with {num_rows} rows and {num_cols} columns."
        summary += f" Headers: {headers_str}."

        # Infer topic from headers
        topic = self._infer_topic(headers)
        if topic:
            summary += f" Contains data about {topic}."

        return summary

    def _build_full_embedding_text(
        self,
        raw_content: str,
        headers: list[str],
        rows: list[list[str]],
        summary: str,
    ) -> str:
        """Build full embedding text that includes the actual table data.

        Includes the table caption (if detected in raw content), a readable
        representation of headers + all rows, and the summary.

        Args:
            raw_content: Original raw content from the adapter.
            headers: Parsed column headers.
            rows: Parsed data rows.
            summary: Generated summary.

        Returns:
            Full embedding text with searchable table data.
        """
        parts: list[str] = []

        # Try to extract a caption from the raw content (first line if it looks like a title)
        first_line = raw_content.strip().split("\n")[0].strip()
        # Check if first line is a caption (starts with "Table" or doesn't contain separators)
        if (
            first_line
            and "|" not in first_line
            and "\t" not in first_line
            and not first_line.startswith("---")
        ):
            parts.append(first_line)
            parts.append("")

        # Format as readable table with header + rows
        if headers:
            parts.append(" | ".join(headers))
            parts.append("-" * min(len(" | ".join(headers)), 80))

        for row in rows:
            # Pad row to match header length
            padded = row + [""] * (len(headers) - len(row)) if len(row) < len(headers) else row
            parts.append(" | ".join(padded[:len(headers)]))

        return "\n".join(parts)

    def _infer_topic(self, headers: list[str]) -> str:
        """Infer a general topic from table headers.

        Args:
            headers: Column header names.

        Returns:
            Inferred topic string, or empty string if no inference possible.
        """
        if not headers:
            return ""

        # Use the non-trivial headers to build a topic phrase
        # Filter out very generic headers
        generic = {"id", "index", "#", "no", "no.", "number", "row", ""}
        meaningful_headers = [
            h for h in headers
            if h.lower().strip() not in generic
        ]

        if not meaningful_headers:
            return ""

        # Take up to 3 meaningful headers for the topic
        topic_parts = meaningful_headers[:3]
        return ", ".join(topic_parts).lower()
