"""RetrievalUnitBuilder converts EnrichedElements into searchable RetrievalUnits.

Decomposition rules by element_type:
- TABLE → 1 summary unit + N column-level units (minimum 2 total)
- TEXT → semantic chunks with sibling_ids (bidirectional references among same parent)
- IMAGE → single unit with empty sibling_ids
- FORMULA → single unit

Validation:
- Every unit has non-empty embedding_text (discard if empty/whitespace only)
- All sibling_ids reference units with same parent_element_id
- Never halts processing on invalid elements
"""

from __future__ import annotations

import uuid
from collections import defaultdict

from aws_lambda_powertools import Logger

from ..models.data_models import (
    EMBEDDING_VERSION,
    ElementType,
    EnrichedElement,
    Provenance,
    RetrievalUnit,
)

logger = Logger(service="multimodal-rag-enrichment")


class RetrievalUnitBuilder:
    """Converts EnrichedElements into one or more RetrievalUnits.

    Decomposition rules:
    - TABLE → 1 summary unit + N column-level units (minimum 2 total)
    - TEXT → semantic chunks with sibling_ids (bidirectional references)
    - IMAGE → single unit with empty sibling_ids
    - FORMULA → single unit

    Validation:
    - Every unit has non-empty embedding_text
    - All sibling_ids reference units with same parent_element_id
    """

    def build(self, enriched_elements: list[EnrichedElement]) -> list[RetrievalUnit]:
        """Build RetrievalUnits from enriched elements.

        Groups TEXT elements by parent element_id to establish sibling
        relationships. Other types are processed individually.

        Args:
            enriched_elements: List of enriched elements to convert.

        Returns:
            List of RetrievalUnit instances ready for embedding and storage.
            Elements with empty/whitespace-only embedding_text are discarded.
        """
        if not enriched_elements:
            return []

        all_units: list[RetrievalUnit] = []

        # Group TEXT elements by parent element_id for sibling assignment
        text_groups: dict[str, list[EnrichedElement]] = defaultdict(list)

        for enriched in enriched_elements:
            try:
                if enriched.element_type == ElementType.TEXT:
                    text_groups[enriched.element_id].append(enriched)
                elif enriched.element_type == ElementType.TABLE:
                    units = self._build_table_units(enriched)
                    all_units.extend(units)
                elif enriched.element_type == ElementType.IMAGE:
                    unit = self._build_image_unit(enriched)
                    if unit is not None:
                        all_units.append(unit)
                elif enriched.element_type == ElementType.FORMULA:
                    unit = self._build_formula_unit(enriched)
                    if unit is not None:
                        all_units.append(unit)
                else:
                    logger.warning(
                        "Unknown element_type, skipping",
                        extra={
                            "element_id": enriched.element_id,
                            "element_type": str(enriched.element_type),
                        },
                    )
            except Exception:
                logger.exception(
                    "Error processing enriched element, skipping",
                    extra={"element_id": enriched.element_id},
                )

        # Process TEXT groups with sibling relationships
        for parent_id, text_elements in text_groups.items():
            try:
                units = self._build_text_units(text_elements)
                all_units.extend(units)
            except Exception:
                logger.exception(
                    "Error building text units for parent, skipping",
                    extra={"parent_element_id": parent_id},
                )

        return all_units

    def _build_text_units(
        self, text_elements: list[EnrichedElement]
    ) -> list[RetrievalUnit]:
        """Build RetrievalUnits for TEXT elements with sibling references.

        If multiple chunks exist for the same parent element_id, each unit
        references all other units as siblings (bidirectional).
        If only one chunk, sibling_ids is empty.

        Args:
            text_elements: All EnrichedElements sharing the same parent element_id.

        Returns:
            List of valid RetrievalUnits (empty embedding_text elements discarded).
        """
        # First pass: create units with unique retrieval_ids, filter invalid
        valid_elements: list[tuple[EnrichedElement, str]] = []
        for element in text_elements:
            if not self._has_valid_embedding_text(element.embedding_text):
                logger.debug(
                    "Discarding TEXT element with empty embedding_text",
                    extra={"element_id": element.element_id},
                )
                continue
            retrieval_id = self._generate_retrieval_id()
            valid_elements.append((element, retrieval_id))

        if not valid_elements:
            return []

        # Determine sibling_ids: if multiple valid units, they reference each other
        all_retrieval_ids = [rid for _, rid in valid_elements]

        units: list[RetrievalUnit] = []
        for element, retrieval_id in valid_elements:
            if len(valid_elements) > 1:
                # Bidirectional siblings: reference all others with same parent
                sibling_ids = [rid for rid in all_retrieval_ids if rid != retrieval_id]
            else:
                # Single chunk: empty sibling_ids
                sibling_ids = []

            unit = RetrievalUnit(
                retrieval_id=retrieval_id,
                parent_element_id=element.element_id,
                embedding_text=element.embedding_text,
                element_type=ElementType.TEXT,
                provenance=element.provenance,
                metadata=self._build_text_metadata(element),
                sibling_ids=sibling_ids,
                embedding_version=EMBEDDING_VERSION,
            )
            units.append(unit)

        return units

    def _build_table_units(self, enriched: EnrichedElement) -> list[RetrievalUnit]:
        """Build RetrievalUnits for TABLE element: 1 summary + N column units.

        Produces minimum 2 total units (summary + at least 1 column/content unit).
        If table has no headers, produces summary + 1 unit with full content.

        Args:
            enriched: TABLE EnrichedElement with table_summary, table_headers, table_rows.

        Returns:
            List of RetrievalUnits (minimum 2 if summary is valid).
        """
        units: list[RetrievalUnit] = []

        # Summary unit
        summary_text = enriched.table_summary or ""
        if self._has_valid_embedding_text(summary_text):
            summary_unit = RetrievalUnit(
                retrieval_id=self._generate_retrieval_id(),
                parent_element_id=enriched.element_id,
                embedding_text=summary_text,
                element_type=ElementType.TABLE,
                provenance=enriched.provenance,
                metadata=self._build_table_metadata(enriched, is_summary=True),
                sibling_ids=[],
                embedding_version=EMBEDDING_VERSION,
            )
            units.append(summary_unit)

        # Column-level units
        if enriched.table_headers:
            for col_idx, header in enumerate(enriched.table_headers):
                column_data = self._extract_column_data(
                    enriched.table_rows, col_idx
                )
                embedding_text = f"{header}: {column_data}"

                if self._has_valid_embedding_text(embedding_text):
                    col_unit = RetrievalUnit(
                        retrieval_id=self._generate_retrieval_id(),
                        parent_element_id=enriched.element_id,
                        embedding_text=embedding_text,
                        element_type=ElementType.TABLE,
                        provenance=enriched.provenance,
                        metadata=self._build_table_metadata(
                            enriched, is_summary=False, column_index=col_idx
                        ),
                        sibling_ids=[],
                        embedding_version=EMBEDDING_VERSION,
                    )
                    units.append(col_unit)
        else:
            # No headers: produce 1 unit with full content
            full_content = self._build_table_full_content(enriched)
            if self._has_valid_embedding_text(full_content):
                content_unit = RetrievalUnit(
                    retrieval_id=self._generate_retrieval_id(),
                    parent_element_id=enriched.element_id,
                    embedding_text=full_content,
                    element_type=ElementType.TABLE,
                    provenance=enriched.provenance,
                    metadata=self._build_table_metadata(enriched, is_summary=False),
                    sibling_ids=[],
                    embedding_version=EMBEDDING_VERSION,
                )
                units.append(content_unit)

        # Ensure minimum 2 units if we have a summary but no column units
        if len(units) == 1 and units[0].metadata.get("is_table_summary"):
            # Add a fallback content unit using embedding_text from the enriched element
            fallback_text = enriched.embedding_text
            if self._has_valid_embedding_text(fallback_text):
                fallback_unit = RetrievalUnit(
                    retrieval_id=self._generate_retrieval_id(),
                    parent_element_id=enriched.element_id,
                    embedding_text=fallback_text,
                    element_type=ElementType.TABLE,
                    provenance=enriched.provenance,
                    metadata=self._build_table_metadata(enriched, is_summary=False),
                    sibling_ids=[],
                    embedding_version=EMBEDDING_VERSION,
                )
                units.append(fallback_unit)

        # Assign sibling_ids across all table units (they share same parent)
        if len(units) > 1:
            all_ids = [u.retrieval_id for u in units]
            for unit in units:
                unit.sibling_ids = [rid for rid in all_ids if rid != unit.retrieval_id]

        # Validate: discard any units with empty embedding_text (final check)
        units = [u for u in units if self._has_valid_embedding_text(u.embedding_text)]

        return units

    def _build_image_unit(self, enriched: EnrichedElement) -> RetrievalUnit | None:
        """Build a single RetrievalUnit for IMAGE element with empty sibling_ids.

        Args:
            enriched: IMAGE EnrichedElement with image_description as embedding_text.

        Returns:
            Single RetrievalUnit or None if embedding_text is empty.
        """
        # Use image_description as embedding_text if main embedding_text is empty
        embedding_text = enriched.embedding_text
        if not self._has_valid_embedding_text(embedding_text):
            embedding_text = enriched.image_description or ""

        if not self._has_valid_embedding_text(embedding_text):
            logger.debug(
                "Discarding IMAGE element with empty embedding_text",
                extra={"element_id": enriched.element_id},
            )
            return None

        return RetrievalUnit(
            retrieval_id=self._generate_retrieval_id(),
            parent_element_id=enriched.element_id,
            embedding_text=embedding_text,
            element_type=ElementType.IMAGE,
            provenance=enriched.provenance,
            metadata=self._build_image_metadata(enriched),
            sibling_ids=[],
            embedding_version=EMBEDDING_VERSION,
        )

    def _build_formula_unit(self, enriched: EnrichedElement) -> RetrievalUnit | None:
        """Build a single RetrievalUnit for FORMULA element.

        Args:
            enriched: FORMULA EnrichedElement with formula embedding_text.

        Returns:
            Single RetrievalUnit or None if embedding_text is empty.
        """
        embedding_text = enriched.embedding_text
        if not self._has_valid_embedding_text(embedding_text):
            logger.debug(
                "Discarding FORMULA element with empty embedding_text",
                extra={"element_id": enriched.element_id},
            )
            return None

        return RetrievalUnit(
            retrieval_id=self._generate_retrieval_id(),
            parent_element_id=enriched.element_id,
            embedding_text=embedding_text,
            element_type=ElementType.FORMULA,
            provenance=enriched.provenance,
            metadata=self._build_formula_metadata(enriched),
            sibling_ids=[],
            embedding_version=EMBEDDING_VERSION,
        )

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _generate_retrieval_id() -> str:
        """Generate a unique retrieval_id using UUID4."""
        return str(uuid.uuid4())

    @staticmethod
    def _has_valid_embedding_text(text: str | None) -> bool:
        """Check that embedding_text is non-empty and contains non-whitespace."""
        if text is None:
            return False
        return len(text.strip()) > 0

    @staticmethod
    def _extract_column_data(rows: list[list[str]], col_idx: int) -> str:
        """Extract a sample of column data for embedding text.

        Takes up to first 5 non-empty values from the column.
        """
        values: list[str] = []
        for row in rows:
            if col_idx < len(row) and row[col_idx].strip():
                values.append(row[col_idx].strip())
                if len(values) >= 5:
                    break

        if not values:
            return ""
        return ", ".join(values)

    @staticmethod
    def _build_table_full_content(enriched: EnrichedElement) -> str:
        """Build full content string for a table without headers."""
        parts: list[str] = []
        for row in enriched.table_rows:
            row_text = " | ".join(cell.strip() for cell in row if cell.strip())
            if row_text:
                parts.append(row_text)
        return "\n".join(parts) if parts else enriched.embedding_text

    @staticmethod
    def _build_text_metadata(enriched: EnrichedElement) -> dict:
        """Build metadata dict for TEXT RetrievalUnit."""
        metadata: dict = {
            "content_type": "text",
        }
        if enriched.file_id:
            metadata["file_id"] = enriched.file_id
        if enriched.course_id:
            metadata["course_id"] = enriched.course_id
        if enriched.module_id:
            metadata["module_id"] = enriched.module_id
        if enriched.provenance.page_num is not None:
            metadata["page_num"] = enriched.provenance.page_num
        return metadata

    @staticmethod
    def _build_table_metadata(
        enriched: EnrichedElement,
        is_summary: bool,
        column_index: int | None = None,
    ) -> dict:
        """Build metadata dict for TABLE RetrievalUnit."""
        metadata: dict = {
            "content_type": "table",
            "is_table_summary": is_summary,
        }
        if column_index is not None:
            metadata["column_index"] = column_index
        if enriched.file_id:
            metadata["file_id"] = enriched.file_id
        if enriched.course_id:
            metadata["course_id"] = enriched.course_id
        if enriched.module_id:
            metadata["module_id"] = enriched.module_id
        if enriched.provenance.page_num is not None:
            metadata["page_num"] = enriched.provenance.page_num
        return metadata

    @staticmethod
    def _build_image_metadata(enriched: EnrichedElement) -> dict:
        """Build metadata dict for IMAGE RetrievalUnit."""
        metadata: dict = {
            "content_type": "image",
        }
        if enriched.image_s3_key:
            metadata["image_s3_key"] = enriched.image_s3_key
        if enriched.image_type:
            metadata["image_type"] = enriched.image_type
        if enriched.topics:
            metadata["topics"] = enriched.topics
        if enriched.file_id:
            metadata["file_id"] = enriched.file_id
        if enriched.course_id:
            metadata["course_id"] = enriched.course_id
        if enriched.module_id:
            metadata["module_id"] = enriched.module_id
        if enriched.provenance.page_num is not None:
            metadata["page_num"] = enriched.provenance.page_num
        return metadata

    @staticmethod
    def _build_formula_metadata(enriched: EnrichedElement) -> dict:
        """Build metadata dict for FORMULA RetrievalUnit."""
        metadata: dict = {
            "content_type": "formula",
        }
        if enriched.latex_repr:
            metadata["latex_repr"] = enriched.latex_repr
        if enriched.formula_concepts:
            metadata["formula_concepts"] = enriched.formula_concepts
        if enriched.file_id:
            metadata["file_id"] = enriched.file_id
        if enriched.course_id:
            metadata["course_id"] = enriched.course_id
        if enriched.module_id:
            metadata["module_id"] = enriched.module_id
        if enriched.provenance.page_num is not None:
            metadata["page_num"] = enriched.provenance.page_num
        return metadata
