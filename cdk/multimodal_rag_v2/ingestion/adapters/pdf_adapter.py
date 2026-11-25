"""PDF adapter using PyMuPDF (fitz) for content extraction.

Extracts text blocks, images, tables, and formulas from all pages.
Handles per-page failures gracefully: logs the error and continues.
Filters out images smaller than 100x100 pixels. Images are stored as PNG,
downscaled to the vision models' limits as they are extracted (image_fit).
"""

from __future__ import annotations

import dataclasses
import re
from typing import TYPE_CHECKING

import fitz  # PyMuPDF

from aws_lambda_powertools import Logger

from ...models.data_models import ElementType, Provenance, RawElement
from ..base_adapter import BaseAdapter
from ..image_fit import MAX_LONG_EDGE_PX, FittedImage, fit_image

if TYPE_CHECKING:
    from ...models.data_models import FileMetadata

logger = Logger(service="multimodal-rag-ingestion")

# Minimum image dimensions (pixels) — images below this are filtered out
_MIN_IMAGE_WIDTH = 100
_MIN_IMAGE_HEIGHT = 100

# Regex pattern to detect LaTeX-like content in text blocks
_LATEX_PATTERN = re.compile(
    r"(?:"
    r"\\(?:frac|sqrt|sum|int|prod|lim|infty|alpha|beta|gamma|delta|theta|lambda|sigma|omega|partial|nabla)"
    r"|\\(?:begin|end)\{(?:equation|align|gather|math|displaymath)\}"
    r"|\$\$.+?\$\$"
    r"|\$.+?\$"
    r"|\\\[.+?\\\]"
    r"|\\\(.+?\\\)"
    r")",
    re.DOTALL,
)


class PdfAdapter(BaseAdapter):
    """Extract content elements from PDF files using PyMuPDF."""

    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract text blocks, images, tables, and formulas from a PDF.

        Args:
            file_content: Raw PDF bytes.
            file_metadata: Metadata about the uploaded file.

        Returns:
            List of RawElement instances with provenance.

        Raises:
            ExtractionFailureError: If the PDF cannot be opened at all.
        """
        from ..exceptions import ExtractionFailureError

        try:
            doc = fitz.open(stream=file_content, filetype="pdf")
        except Exception as exc:
            logger.exception(
                "Failed to open PDF document",
                extra={"file_key": file_metadata.file_key},
            )
            raise ExtractionFailureError(
                file_key=file_metadata.file_key,
                reason=f"Cannot open PDF: {exc}",
            ) from exc

        elements: list[RawElement] = []

        for page_num in range(len(doc)):
            try:
                page = doc[page_num]
                page_elements = self._extract_page(page, page_num + 1)
                elements.extend(page_elements)
            except Exception:
                logger.exception(
                    "Failed to extract page, continuing with remaining pages",
                    extra={
                        "file_key": file_metadata.file_key,
                        "page_num": page_num + 1,
                    },
                )
                continue

        doc.close()
        return elements

    def _extract_page(self, page: fitz.Page, page_num: int) -> list[RawElement]:
        """Extract all content elements from a single PDF page.

        Args:
            page: A PyMuPDF page object.
            page_num: 1-based page number.

        Returns:
            List of RawElement instances from this page.
        """
        elements: list[RawElement] = []
        position_index = 0

        # --- Extract text blocks ---
        text_blocks = page.get_text("blocks")
        for block in text_blocks:
            # blocks format: (x0, y0, x1, y1, text, block_no, block_type)
            # block_type 0 = text, 1 = image
            if len(block) < 7:
                continue
            block_type = block[6]
            if block_type != 0:
                continue

            text = block[4].strip()
            if not text:
                continue

            # Determine if this text block contains LaTeX/formula content
            if _LATEX_PATTERN.search(text):
                elements.append(
                    RawElement(
                        content=text,
                        element_type=ElementType.FORMULA,
                        provenance=Provenance(
                            page_num=page_num,
                            position_index=position_index,
                        ),
                        raw_metadata={"source": "pdf_text_block"},
                    )
                )
            else:
                elements.append(
                    RawElement(
                        content=text,
                        element_type=ElementType.TEXT,
                        provenance=Provenance(
                            page_num=page_num,
                            position_index=position_index,
                        ),
                        raw_metadata={"source": "pdf_text_block"},
                    )
                )
            position_index += 1

        # --- Extract images ---
        image_list = page.get_images(full=True)
        for img_info in image_list:
            try:
                xref = img_info[0]
                base_image = page.parent.extract_image(xref)
                if not base_image:
                    continue

                width = base_image.get("width", 0)
                height = base_image.get("height", 0)

                # Filter out images smaller than 100x100
                if width < _MIN_IMAGE_WIDTH or height < _MIN_IMAGE_HEIGHT:
                    continue

                img_ext = base_image.get("ext", "png")

                # PNG for consistency, downscaled to the vision limits as each
                # image is extracted so full-resolution copies never pile up.
                fitted = fit_image(base_image["image"], force_png=True)
                if fitted is None:
                    # Formats Pillow can't read (JPX, JBIG2, ...): let PyMuPDF decode.
                    fitted = self._fit_via_pixmap(base_image["image"])
                base_image = None  # release the source bytes

                raw_metadata = {
                    "source": "pdf_image",
                    "width": width,
                    "height": height,
                    "original_format": img_ext,
                }
                if fitted.resized:
                    raw_metadata["stored_width"] = fitted.width
                    raw_metadata["stored_height"] = fitted.height

                elements.append(
                    RawElement(
                        content=fitted.content,
                        element_type=ElementType.IMAGE,
                        provenance=Provenance(
                            page_num=page_num,
                            position_index=position_index,
                        ),
                        raw_metadata=raw_metadata,
                    )
                )
                position_index += 1
            except Exception:
                logger.exception(
                    "Failed to extract image from page, skipping",
                    extra={"page_num": page_num, "xref": img_info[0]},
                )
                continue

        # --- Extract tables ---
        tables = self._extract_tables(page)
        for table_content in tables:
            elements.append(
                RawElement(
                    content=table_content,
                    element_type=ElementType.TABLE,
                    provenance=Provenance(
                        page_num=page_num,
                        position_index=position_index,
                    ),
                    raw_metadata={"source": "pdf_table"},
                )
            )
            position_index += 1

        # --- Page-level rendering fallback for vector graphics ---
        # If a page has drawing commands (vector diagrams/charts) but no raster
        # images were extracted, render the full page as a PNG image.
        page_has_raster_images = any(
            el.element_type == ElementType.IMAGE and el.provenance.page_num == page_num
            for el in elements
        )
        page_has_drawings = len(page.get_drawings()) > 5  # threshold: >5 drawing ops suggests a diagram

        if not page_has_raster_images and page_has_drawings:
            try:
                # Render at 2x for clarity, but no larger than the vision models
                # read, so a poster-sized page doesn't become a huge pixmap.
                long_edge_pt = max(page.rect.width, page.rect.height) or 1
                zoom = min(2.0, MAX_LONG_EDGE_PX / long_edge_pt)
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                render_width = pix.width
                render_height = pix.height
                page_image_bytes = pix.tobytes("png")
                pix = None  # release

                raw_metadata = {
                    "source": "pdf_page_render",
                    "width": render_width,
                    "height": render_height,
                    "render_reason": "vector_graphics_detected",
                }
                fitted = fit_image(page_image_bytes, force_png=True)  # byte limit
                if fitted is not None:
                    page_image_bytes = fitted.content
                    if fitted.resized:
                        raw_metadata["stored_width"] = fitted.width
                        raw_metadata["stored_height"] = fitted.height

                elements.append(
                    RawElement(
                        content=page_image_bytes,
                        element_type=ElementType.IMAGE,
                        provenance=Provenance(
                            page_num=page_num,
                            position_index=position_index,
                        ),
                        raw_metadata=raw_metadata,
                    )
                )
                position_index += 1
            except Exception:
                logger.warning(
                    "Failed to render page as image fallback",
                    extra={"page_num": page_num},
                )

        return elements

    @staticmethod
    def _fit_via_pixmap(image_bytes: bytes) -> FittedImage:
        """Decode with PyMuPDF (for formats Pillow can't read), then fit as PNG.

        Raises if PyMuPDF can't decode or encode it either; the caller skips
        the image, as it did before.
        """
        pix = fitz.Pixmap(image_bytes)
        # Halve while that still leaves at least the target size, so the PNG
        # handed to Pillow for the final resize stays small.
        shrink = 0
        while max(pix.width, pix.height) >> (shrink + 1) >= MAX_LONG_EDGE_PX:
            shrink += 1
        if shrink:
            pix.shrink(shrink)
        if pix.colorspace is not None and pix.colorspace.n == 4:
            pix = fitz.Pixmap(fitz.csRGB, pix)  # PNG can't hold CMYK
        width, height = pix.width, pix.height
        png = pix.tobytes("png")
        pix = None  # release
        fitted = fit_image(png, force_png=True) or FittedImage(
            png, width, height, resized=False
        )
        if shrink and not fitted.resized:
            fitted = dataclasses.replace(fitted, resized=True)
        return fitted

    def _extract_tables(self, page: fitz.Page) -> list[str]:
        """Extract tables from a PDF page.

        Uses PyMuPDF's built-in table finder if available (fitz >= 1.23.0),
        otherwise falls back to detecting structured text layouts.

        Args:
            page: A PyMuPDF page object.

        Returns:
            List of table content strings (structured text representation).
        """
        tables: list[str] = []

        # Use PyMuPDF's table finder if available
        if hasattr(page, "find_tables"):
            try:
                table_finder = page.find_tables()
                for table in table_finder.tables:
                    extracted = table.extract()
                    if not extracted:
                        continue
                    # Format as structured text: pipe-separated rows
                    rows = []
                    for row in extracted:
                        cells = [str(cell) if cell is not None else "" for cell in row]
                        rows.append(" | ".join(cells))
                    table_str = "\n".join(rows)
                    if table_str.strip():
                        tables.append(table_str)
            except Exception:
                logger.exception(
                    "Table finder failed, skipping table extraction for page"
                )

        return tables
