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

        Supports (in priority order):
        - Pipe-separated (Markdown tables)
        - Tab-separated (TSV)
        - Whitespace-aligned (2+ spaces between columns) — common in text
          extracted from PDFs/PPTX
        - Comma-separated (CSV)

        For delimiter-less content we PREFER a whitespace (2+ space) split over
        CSV: space-aligned tables have no commas, so CSV collapses each row to a
        single cell (the "1 column" bug), and CSV shatters numeric cells with
        thousands-separators ("49,995,000" -> "49","995","000"). CSV is used only
        when a whitespace split does NOT yield a multi-column table (i.e. the
        content really is comma-delimited).

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

        # No unambiguous delimiter: choose between a whitespace-aligned parse and
        # a CSV parse by which recovers more header columns. Whitespace wins ties
        # only when it is strictly wider, so a space-aligned table with comma
        # thousands-separators ("49,995,000") is kept intact, while genuine
        # comma-delimited data (where CSV yields >= as many columns) still uses CSV.
        whitespace_rows = self._parse_whitespace(content)
        csv_rows = self._parse_csv(content)
        ws_cols = len(whitespace_rows[0]) if whitespace_rows else 0
        csv_cols = len(csv_rows[0]) if csv_rows else 0

        if ws_cols >= 2 and ws_cols > csv_cols:
            return whitespace_rows
        if csv_cols >= 2:
            return csv_rows
        if ws_cols >= 2:
            return whitespace_rows

        # Neither recovered columns; return whichever is non-empty so the caller
        # can still preserve the raw content (weak-parse fallback in embedding).
        return whitespace_rows or csv_rows

    def _parse_whitespace(self, content: str) -> list[list[str]]:
        """Parse a whitespace-aligned table by splitting on runs of 2+ spaces.

        Column boundaries in PDF/PPTX-extracted tables are typically 2+ spaces,
        while values keep single spaces ("0.01 ms", "n log n", "~3 days"), so a
        2+-space split recovers columns WITHOUT shattering multi-word cells.

        Args:
            content: Whitespace-aligned table content.

        Returns:
            Parsed rows as list of lists.
        """
        rows: list[list[str]] = []
        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue
            cells = [c.strip() for c in re.split(r"\s{2,}", line) if c.strip()]
            if cells:
                rows.append(cells)
        return rows

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

        # Honesty guard: a single "column" whose header packs many whitespace
        # tokens is almost certainly a mis-parsed multi-column table (delimiter
        # not detected). Don't assert a misleading "1 columns" count — the raw
        # table text is preserved in embedding_text instead.
        lone_header = headers[0] if headers else ""
        if num_cols <= 1 and num_rows > 2 and len(lone_header.split()) > 2:
            return (
                f"Table with {num_rows} rows; column structure could not be "
                f"reliably parsed, so the raw table text is preserved."
            )

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
        Falls back to the raw content when parsing produces poor results
        (e.g., only 1 column detected for a multi-column table).

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
        lines = raw_content.strip().split("\n")
        first_line = lines[0].strip() if lines else ""

        # Check if first line is a caption (starts with "Table" or doesn't contain separators)
        caption = ""
        if (
            first_line
            and "|" not in first_line
            and "\t" not in first_line
            and not first_line.startswith("---")
        ):
            caption = first_line

        # If parsing produced a poor result (1 column for what's clearly
        # multi-column), preserve the raw content as embedding_text so the real
        # values stay searchable and available in context — regardless of the
        # (missing) delimiter, rather than emitting a lossy single-column render.
        if len(headers) <= 1 and len(rows) > 2:
            if caption:
                return f"{caption}\n\n{raw_content}"
            return raw_content

        # Normal path: build structured representation
        if caption:
            parts.append(caption)
            parts.append("")

        # Format as readable table with header + rows
        if headers:
            parts.append(" | ".join(headers))
            parts.append("-" * min(len(" | ".join(headers)), 80))

        for row in rows:
            # Pad row to match header length
            padded = row + [""] * (len(headers) - len(row)) if len(row) < len(headers) else row
            parts.append(" | ".join(padded[:len(headers)]))

        result = "\n".join(parts)

        # Final fallback: if the structured result is suspiciously short, use raw content
        if len(result) < len(raw_content) * 0.5 and len(raw_content) > 50:
            if caption:
                return f"{caption}\n\n{raw_content}"
            return raw_content

        return result

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
