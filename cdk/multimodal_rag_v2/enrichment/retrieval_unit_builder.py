"""RetrievalUnitBuilder converts EnrichedElements into searchable RetrievalUnits.

Decomposition rules by element_type:
- TABLE → 1 summary unit + N column-level units (minimum 2 total)
- TEXT → semantic chunks with sibling_ids (bidirectional references among same parent)
- IMAGE → single unit with empty sibling_ids
- FORMULA → single unit

Validation:
- Every unit has non-empty embedding_text (discard if empty/whitespace only)
- TEXT chunk siblings reference units with same parent_element_id
- Caption linking may create sibling relationships across different parent elements
  on the same page (e.g., figure caption text ↔ page image)
- Never halts processing on invalid elements
"""

from __future__ import annotations

import re
import uuid
from collections import defaultdict

from aws_lambda_powertools import Logger

from ..models.data_models import (
    EMBEDDING_VERSION,
    ElementType,
    EnrichedElement,
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
        logger.info("RetrievalUnitBuilder.build() v3 - with caption injection and sibling linking")
        if not enriched_elements:
            return []

        # DEBUG: Check what TEXT elements contain figure/table references
        caption_pattern = re.compile(r"(?:figure|fig\.?|table|algorithm)\s*\d+", re.IGNORECASE)
        text_with_captions = []
        for elem in enriched_elements:
            if elem.element_type == ElementType.TEXT and elem.embedding_text:
                head = elem.embedding_text[:150]
                if caption_pattern.search(head):
                    text_with_captions.append(head[:80])
        logger.info(
            "Caption detection scan",
            extra={
                "text_elements_with_captions": len(text_with_captions),
                "samples": text_with_captions[:5],
                "total_text_elements": sum(1 for e in enriched_elements if e.element_type == ElementType.TEXT),
                "sample_file_ids": list(set(e.file_id for e in enriched_elements[:10])),
                "sample_page_nums": [e.provenance.page_num for e in enriched_elements[:10]],
            },
        )

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

        # Post-processing: inject table/figure captions into TABLE/IMAGE embedding_text
        # This makes table data directly searchable by label (e.g., "Table 1.1")
        self._inject_captions_into_elements(all_units, enriched_elements)

        # Post-processing: link figure/table captions to page images
        self._link_captions_to_page_images(all_units)

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
            metadata["provenance_page_num"] = enriched.provenance.page_num
        metadata["provenance_position_index"] = enriched.provenance.position_index
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
        # Structured table data for client-side rendering (Issue #2). Rows are
        # capped to bound the JSONB metadata size; course tables are small.
        if enriched.table_headers:
            metadata["table_headers"] = enriched.table_headers
        if enriched.table_rows:
            metadata["table_rows"] = enriched.table_rows[:50]
        if enriched.table_summary:
            metadata["table_summary"] = enriched.table_summary
        if enriched.file_id:
            metadata["file_id"] = enriched.file_id
        if enriched.course_id:
            metadata["course_id"] = enriched.course_id
        if enriched.module_id:
            metadata["module_id"] = enriched.module_id
        if enriched.provenance.page_num is not None:
            metadata["page_num"] = enriched.provenance.page_num
            metadata["provenance_page_num"] = enriched.provenance.page_num
        metadata["provenance_position_index"] = enriched.provenance.position_index
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
            metadata["provenance_page_num"] = enriched.provenance.page_num
        metadata["provenance_position_index"] = enriched.provenance.position_index
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

    # -----------------------------------------------------------------------
    # Caption Injection (makes TABLE/IMAGE units searchable by label)
    # -----------------------------------------------------------------------

    def _inject_captions_into_elements(
        self, units: list[RetrievalUnit], enriched_elements: list[EnrichedElement]
    ) -> None:
        """Find table/figure captions from enriched text and prepend them to TABLE/IMAGE units.

        This makes TABLE units directly searchable by their label (e.g., "Table 1.1")
        without requiring sibling linking. Works by finding caption text on the same
        page as a TABLE/IMAGE element and prepending it to the element's embedding_text.

        Modifies units in place.
        """
        # Collect captions from enriched TEXT elements indexed by page_num.
        # M10: anchor with .match (the pattern begins with \s*) so only chunks
        # that BEGIN with a caption count — a mid-text reference like "as shown
        # in Figure 2.1" is no longer treated as a caption. Collect ALL captions
        # per page so ambiguous (multi-figure) pages can be detected.
        # Note: build() processes one file at a time, so cross-file collisions are impossible
        table_captions: dict[int, list[str]] = defaultdict(list)
        figure_captions: dict[int, list[str]] = defaultdict(list)

        for elem in enriched_elements:
            if elem.element_type != ElementType.TEXT:
                continue
            if not elem.embedding_text:
                continue

            match = self._CAPTION_PATTERN.match(elem.embedding_text[:150])
            if not match:
                continue

            page_num = elem.provenance.page_num
            if page_num is None:
                continue

            caption_text = elem.embedding_text.split("\n")[0][:200]  # First line, max 200 chars

            if self._TABLE_SUBPATTERN.search(match.group(0)):
                table_captions[page_num].append(caption_text)
            elif self._FIGURE_SUBPATTERN.search(match.group(0)):
                figure_captions[page_num].append(caption_text)

        if not table_captions and not figure_captions:
            return

        def _sole_caption(by_page: dict[int, list[str]], page: int) -> str | None:
            # M10: only inject when there is exactly ONE caption of this type on
            # the page. Multiple captions (a multi-figure page) are ambiguous —
            # injecting a single page-level caption into every element mislabels
            # them, so skip rather than guess.
            caps = by_page.get(page)
            return caps[0] if caps and len(caps) == 1 else None

        # Inject captions into TABLE/IMAGE units on unambiguous pages
        injected = 0
        skipped_ambiguous = 0
        for unit in units:
            page_num = unit.provenance.page_num
            if page_num is None:
                continue

            if unit.element_type == ElementType.TABLE:
                by_page = table_captions
            elif unit.element_type == ElementType.IMAGE:
                by_page = figure_captions
            else:
                continue

            caption = _sole_caption(by_page, page_num)
            if caption is None:
                if len(by_page.get(page_num, [])) > 1:
                    skipped_ambiguous += 1
                continue

            if caption.lower() not in unit.embedding_text.lower():
                unit.embedding_text = f"{caption}\n{unit.embedding_text}"
                injected += 1

        if injected or skipped_ambiguous:
            logger.info(
                "Captions injected into element units",
                extra={
                    "injected_count": injected,
                    "skipped_ambiguous_pages": skipped_ambiguous,
                },
            )

    # -----------------------------------------------------------------------
    # Caption-Element Sibling Linking
    # -----------------------------------------------------------------------

    # Pattern for figure/table/algorithm captions at the START of text content.
    # Uses re.match (not search) to only match chunks that begin with a caption,
    # avoiding false positives from mid-text references like "as shown in Figure 2.1".
    _CAPTION_PATTERN = re.compile(
        r"\s*(?:figure|fig\.?|table|algorithm)\s*\d+(?:[.-]\d+)*",
        re.IGNORECASE,
    )

    # Sub-patterns to classify caption type (compiled once at class level)
    _FIGURE_SUBPATTERN = re.compile(r"(?:figure|fig\.?)\s*\d+", re.IGNORECASE)
    _TABLE_SUBPATTERN = re.compile(r"table\s*\d+", re.IGNORECASE)

    def _link_captions_to_page_images(self, units: list[RetrievalUnit]) -> None:
        """Link text units containing figure/table captions to visual/data units on the same page.

        Creates bidirectional sibling_ids between:
        - Figure/image captions ↔ IMAGE elements on the same page AND file
        - Table captions ↔ TABLE elements on the same page AND file

        Design note: page image is a fallback visual representation of the figure,
        not a precise figure-level extraction. A page may contain multiple figures
        and all their captions will link to the same page image.

        Indexed by (file_id, page_num) to prevent cross-file collisions.

        Modifies units in place.
        """
        # Index image and table units by page_num
        # Note: build() processes one file at a time, so cross-file collisions are impossible
        images_by_page: dict[int, list[RetrievalUnit]] = defaultdict(list)
        tables_by_page: dict[int, list[RetrievalUnit]] = defaultdict(list)

        for unit in units:
            page_num = unit.provenance.page_num
            if page_num is None:
                continue
            if unit.element_type == ElementType.IMAGE:
                images_by_page[page_num].append(unit)
            elif unit.element_type == ElementType.TABLE:
                tables_by_page[page_num].append(unit)

        if not images_by_page and not tables_by_page:
            logger.info("No images or tables to link", extra={"unit_count": len(units)})
            return  # Nothing to link

        logger.info(
            "Caption linking: indexing complete",
            extra={
                "image_pages": list(images_by_page.keys()),
                "table_pages": list(tables_by_page.keys()),
            },
        )

        # Find text units with caption patterns and link to appropriate elements
        linked_count = 0
        for unit in units:
            if unit.element_type != ElementType.TEXT:
                continue

            # M10: anchor to the chunk start (.match; the pattern begins with
            # \s*) so only chunks that BEGIN with a caption create sibling links
            # / set figure_ref — a mid-text reference like "as shown in Figure
            # 2.1" no longer over-links.
            match = self._CAPTION_PATTERN.match(unit.embedding_text[:150])
            if not match:
                continue

            page_num = unit.provenance.page_num
            if page_num is None:
                continue

            # Store the figure reference in metadata
            unit.metadata["figure_ref"] = match.group(0).strip().lower()

            # Determine what to link to based on caption type
            caption_text = match.group(0)
            is_table_caption = self._TABLE_SUBPATTERN.search(caption_text) is not None
            is_figure_caption = self._FIGURE_SUBPATTERN.search(caption_text) is not None

            # Build targets list without mutating the indexed lists
            targets: list[RetrievalUnit] = []
            if is_table_caption:
                targets = (
                    tables_by_page.get(page_num, [])
                    + images_by_page.get(page_num, [])
                )
            elif is_figure_caption:
                targets = list(images_by_page.get(page_num, []))

            if not targets:
                continue

            # Create bidirectional sibling links
            for target_unit in targets:
                if target_unit.retrieval_id not in unit.sibling_ids:
                    unit.sibling_ids.append(target_unit.retrieval_id)
                if unit.retrieval_id not in target_unit.sibling_ids:
                    target_unit.sibling_ids.append(unit.retrieval_id)

            linked_count += 1

        if linked_count > 0:
            logger.info(
                "Caption-element sibling linking complete",
                extra={"linked_captions": linked_count},
            )
