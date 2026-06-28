"""Adapter for LaTeX files (.tex).

Uses pylatexenc to parse LaTeX content into text blocks (TEXT elements)
and math environments (FORMULA elements). No AI/LLM calls.
"""

from __future__ import annotations

import re

from aws_lambda_powertools import Logger
from pylatexenc.latexwalker import (
    LatexEnvironmentNode,
    LatexMacroNode,
    LatexMathNode,
    LatexWalker,
)

from ...models.data_models import ElementType, FileMetadata, Provenance, RawElement
from ..base_adapter import BaseAdapter
from ..exceptions import ExtractionFailureError

logger = Logger(service="multimodal-rag-ingestion")

# Math environment names that indicate formula content
_MATH_ENVIRONMENTS = frozenset({
    "equation",
    "equation*",
    "align",
    "align*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "displaymath",
    "math",
    "eqnarray",
    "eqnarray*",
})

# Environment names that contain tabular/grid data → TABLE elements
_TABULAR_ENVIRONMENTS = frozenset({"tabular", "tabular*", "array", "longtable", "tabularx"})

# Regex to pull the filename out of \includegraphics[opts]{file}
_INCLUDEGRAPHICS_PATTERN = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}")


class LatexAdapter(BaseAdapter):
    """Extracts text blocks and formula elements from LaTeX files."""

    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Parse LaTeX content and extract TEXT and FORMULA elements.

        Args:
            file_content: Raw bytes of the LaTeX file.
            file_metadata: Metadata about the uploaded file.

        Returns:
            List of RawElement instances (TEXT and FORMULA types).

        Raises:
            ExtractionFailureError: If the LaTeX content cannot be parsed at all.
        """
        if not file_content:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="LaTeX file is empty (zero bytes)",
            )

        try:
            latex_text = file_content.decode("utf-8", errors="replace")
        except Exception as exc:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"Failed to decode LaTeX file: {exc}",
            ) from exc

        if not latex_text.strip():
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason="LaTeX file contains no content after decoding",
            )

        logger.info(
            "Parsing LaTeX content",
            extra={
                "file_key": file_metadata.file_key,
                "content_length": len(latex_text),
            },
        )

        try:
            walker = LatexWalker(latex_text)
            nodelist, _, _ = walker.get_latex_nodes()
        except Exception as exc:
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"LaTeX parsing failed: {exc}",
            ) from exc

        elements: list[RawElement] = []
        position_index_counter = [0]

        self._walk_nodes(
            nodelist, latex_text, elements, position_index_counter
        )

        # \includegraphics references → searchable TEXT. The referenced image
        # files are external to the .tex source (no bytes available), so we index
        # them as figure references rather than attempting to fetch them.
        for match in _INCLUDEGRAPHICS_PATTERN.finditer(latex_text):
            filename = match.group(1).strip()
            if filename:
                elements.append(
                    RawElement(
                        content=f"Figure: {filename}",
                        element_type=ElementType.TEXT,
                        provenance=Provenance(
                            page_num=1,
                            position_index=position_index_counter[0],
                        ),
                        raw_metadata={"source": "latex_includegraphics", "graphic": filename},
                    )
                )
                position_index_counter[0] += 1

        logger.info(
            "LaTeX extraction complete",
            extra={
                "file_key": file_metadata.file_key,
                "element_count": len(elements),
                "text_count": sum(
                    1 for e in elements if e.element_type == ElementType.TEXT
                ),
                "formula_count": sum(
                    1 for e in elements if e.element_type == ElementType.FORMULA
                ),
                "table_count": sum(
                    1 for e in elements if e.element_type == ElementType.TABLE
                ),
            },
        )

        return elements

    def _walk_nodes(
        self,
        nodelist: list,
        source: str,
        elements: list[RawElement],
        position_index_counter: list[int],
    ) -> None:
        """Recursively walk the LaTeX node tree, extracting TEXT and FORMULA elements."""
        if not nodelist:
            return

        # Accumulate consecutive text content into a single TEXT element
        text_buffer: list[str] = []

        for node in nodelist:
            if node is None:
                continue

            if isinstance(node, LatexMathNode):
                # Flush any accumulated text first
                self._flush_text_buffer(text_buffer, elements, position_index_counter)

                # Extract math content
                math_content = self._get_node_latex(node, source)
                if math_content.strip():
                    elements.append(
                        RawElement(
                            content=math_content,
                            element_type=ElementType.FORMULA,
                            provenance=Provenance(
                                page_num=1,
                                position_index=position_index_counter[0],
                            ),
                            raw_metadata={"math_mode": node.displaytype},
                        )
                    )
                    position_index_counter[0] += 1

            elif isinstance(node, LatexEnvironmentNode):
                env_name = node.environmentname if node.environmentname else ""

                if env_name.lower() in _MATH_ENVIRONMENTS:
                    # Flush any accumulated text first
                    self._flush_text_buffer(
                        text_buffer, elements, position_index_counter
                    )

                    # Extract formula environment
                    formula_content = self._get_node_latex(node, source)
                    if formula_content.strip():
                        elements.append(
                            RawElement(
                                content=formula_content,
                                element_type=ElementType.FORMULA,
                                provenance=Provenance(
                                    page_num=1,
                                    position_index=position_index_counter[0],
                                ),
                                raw_metadata={"environment": env_name},
                            )
                        )
                        position_index_counter[0] += 1
                else:
                    # Tabular/grid environment → TABLE element
                    if env_name.lower() in _TABULAR_ENVIRONMENTS:
                        self._flush_text_buffer(
                            text_buffer, elements, position_index_counter
                        )
                        table_text = self._tabular_to_text(
                            self._get_node_latex(node, source)
                        )
                        if table_text.strip():
                            elements.append(
                                RawElement(
                                    content=table_text,
                                    element_type=ElementType.TABLE,
                                    provenance=Provenance(
                                        page_num=1,
                                        position_index=position_index_counter[0],
                                    ),
                                    raw_metadata={
                                        "source": "latex_tabular",
                                        "environment": env_name,
                                    },
                                )
                            )
                            position_index_counter[0] += 1
                    # Non-math, non-tabular environment: recurse into its children
                    elif hasattr(node, "nodelist") and node.nodelist:
                        self._walk_nodes(
                            node.nodelist, source, elements, position_index_counter
                        )
            else:
                # \includegraphics is handled separately (full-source scan emits a
                # clean "Figure: <file>" TEXT element); skip it here to avoid
                # accumulating raw LaTeX into the text buffer.
                if isinstance(node, LatexMacroNode) and (node.macroname or "") == "includegraphics":
                    continue
                # Text node or other node types — accumulate text
                node_text = self._get_node_text(node, source)
                if node_text.strip():
                    text_buffer.append(node_text)

        # Flush any remaining text
        self._flush_text_buffer(text_buffer, elements, position_index_counter)

    def _flush_text_buffer(
        self,
        text_buffer: list[str],
        elements: list[RawElement],
        position_index_counter: list[int],
    ) -> None:
        """Flush accumulated text content as a TEXT element."""
        if not text_buffer:
            return

        combined_text = " ".join(text_buffer).strip()
        text_buffer.clear()

        if combined_text:
            elements.append(
                RawElement(
                    content=combined_text,
                    element_type=ElementType.TEXT,
                    provenance=Provenance(
                        page_num=1,
                        position_index=position_index_counter[0],
                    ),
                )
            )
            position_index_counter[0] += 1

    def _get_node_latex(self, node, source: str) -> str:
        """Get the raw LaTeX source for a node."""
        if hasattr(node, "latex_verbatim") and callable(node.latex_verbatim):
            return node.latex_verbatim()
        if hasattr(node, "pos") and hasattr(node, "pos_end"):
            if node.pos is not None and node.pos_end is not None:
                return source[node.pos : node.pos_end]
        return ""

    def _get_node_text(self, node, source: str) -> str:
        """Get text content from a non-math node."""
        # For character/text nodes, extract the character(s) directly
        if hasattr(node, "chars") and node.chars:
            return node.chars
        # Fall back to extracting from source positions
        if hasattr(node, "pos") and hasattr(node, "pos_end"):
            if node.pos is not None and node.pos_end is not None:
                return source[node.pos : node.pos_end]
        return ""

    @staticmethod
    def _tabular_to_text(tabular_latex: str) -> str:
        """Convert a LaTeX tabular/array environment to pipe-separated rows.

        Heuristic (no full LaTeX rendering): strips the \\begin/\\end wrappers and
        column spec, splits rows on ``\\\\``, splits cells on unescaped ``&``, and
        removes rule/formatting commands. Produces readable, searchable rows.
        """
        body = tabular_latex.strip()
        body = re.sub(r"\\begin\{[^}]*\}", "", body, count=1)
        body = re.sub(r"\\end\{[^}]*\}", "", body)
        body = body.strip()

        # Strip a leading balanced column-spec group, e.g. {|l|c|r|} or {p{3cm}l}
        if body.startswith("{"):
            depth = 0
            end = 0
            for i, ch in enumerate(body):
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        break
            body = body[end:]

        rows: list[str] = []
        for raw_row in re.split(r"\\\\", body):
            cleaned = re.sub(r"\\(?:hline|toprule|midrule|bottomrule)\b", "", raw_row)
            cleaned = re.sub(r"\\cline\{[^}]*\}", "", cleaned)
            cells = [
                LatexAdapter._strip_latex_cell(cell)
                for cell in re.split(r"(?<!\\)&", cleaned)
            ]
            if any(cell for cell in cells):
                rows.append(" | ".join(cells))
        return "\n".join(rows)

    @staticmethod
    def _strip_latex_cell(cell: str) -> str:
        """Reduce a single tabular cell's LaTeX to plain text."""
        text = cell.strip()
        text = re.sub(r"\\multicolumn\{[^}]*\}\{[^}]*\}", "", text)
        text = re.sub(
            r"\\(?:textbf|textit|emph|texttt|textsf|mathrm|text)\s*\{([^{}]*)\}",
            r"\1",
            text,
        )
        text = re.sub(r"\\[a-zA-Z]+\*?", "", text)
        text = text.replace("{", "").replace("}", "").replace("\\&", "&")
        return text.strip()
