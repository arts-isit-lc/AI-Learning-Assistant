"""HTML adapter — extracts text, images, and tables from HTML content."""

from __future__ import annotations

import base64
import re
from typing import TYPE_CHECKING

from aws_lambda_powertools import Logger
from bs4 import BeautifulSoup, Tag

from ...models.data_models import ElementType, Provenance, RawElement
from ..base_adapter import BaseAdapter

if TYPE_CHECKING:
    from ...models.data_models import FileMetadata

logger = Logger(service="multimodal-rag-ingestion")

# Tags that contain meaningful text content
_TEXT_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "dd", "dt"}

# Heading tags for section tracking
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


class HtmlAdapter(BaseAdapter):
    """Extract text, images, and tables from HTML files using BeautifulSoup."""

    def extract(
        self, file_content: bytes, file_metadata: FileMetadata
    ) -> list[RawElement]:
        """Extract elements from an HTML file.

        Args:
            file_content: Raw bytes of the HTML file.
            file_metadata: Metadata about the file.

        Returns:
            List of RawElement instances with section-level provenance.
        """
        try:
            html_text = file_content.decode("utf-8")
        except UnicodeDecodeError:
            html_text = file_content.decode("latin-1")

        soup = BeautifulSoup(html_text, "html.parser")
        elements: list[RawElement] = []
        current_section = "body"
        position_index = 0

        # Remove script and style tags as they don't contain content
        for tag in soup.find_all(["script", "style"]):
            tag.decompose()

        body = soup.find("body") or soup

        for element in body.children:
            if not isinstance(element, Tag):
                continue

            try:
                extracted, current_section = self._extract_element(
                    element, current_section, position_index
                )
                elements.extend(extracted)
                position_index += len(extracted)
            except Exception:
                logger.exception(
                    "Failed to extract HTML element",
                    extra={
                        "tag": element.name,
                        "section": current_section,
                        "file_key": file_metadata.file_key,
                    },
                )
                continue

        return elements

    def _extract_element(
        self, element: Tag, current_section: str, position_index: int
    ) -> tuple[list[RawElement], str]:
        """Extract content from an HTML element.

        Args:
            element: A BeautifulSoup Tag.
            current_section: The current heading section name.
            position_index: Current position index.

        Returns:
            Tuple of (extracted elements, updated section name).
        """
        results: list[RawElement] = []

        tag_name = element.name

        # Table element
        if tag_name == "table":
            table_element = self._extract_table(element, current_section, position_index)
            if table_element:
                results.append(table_element)
            return results, current_section

        # Update section tracking for headings
        if tag_name in _HEADING_TAGS:
            heading_text = element.get_text(strip=True)
            if heading_text:
                current_section = heading_text
                results.append(
                    RawElement(
                        content=heading_text,
                        element_type=ElementType.TEXT,
                        provenance=Provenance(
                            section=current_section,
                            position_index=position_index + len(results),
                        ),
                        raw_metadata={"source": "html_heading", "tag": tag_name},
                    )
                )
            return results, current_section

        # Text content elements
        if tag_name in _TEXT_TAGS:
            text = element.get_text(strip=True)
            if text:
                results.append(
                    RawElement(
                        content=text,
                        element_type=ElementType.TEXT,
                        provenance=Provenance(
                            section=current_section,
                            position_index=position_index + len(results),
                        ),
                        raw_metadata={"source": "html_text", "tag": tag_name},
                    )
                )
            return results, current_section

        # Image elements
        if tag_name == "img":
            img_element = self._extract_image(element, current_section, position_index)
            if img_element:
                results.append(img_element)
            return results, current_section

        # For container elements (div, section, article, etc.), recurse into children
        if tag_name in {"div", "section", "article", "main", "aside", "nav", "header", "footer", "figure"}:
            for child in element.children:
                if not isinstance(child, Tag):
                    continue
                try:
                    child_results, current_section = self._extract_element(
                        child, current_section, position_index + len(results)
                    )
                    results.extend(child_results)
                except Exception:
                    logger.exception(
                        "Failed to extract child element",
                        extra={"tag": child.name, "section": current_section},
                    )
                    continue

        # Lists — extract individual list items
        if tag_name in {"ul", "ol"}:
            for li in element.find_all("li", recursive=False):
                try:
                    text = li.get_text(strip=True)
                    if text:
                        results.append(
                            RawElement(
                                content=text,
                                element_type=ElementType.TEXT,
                                provenance=Provenance(
                                    section=current_section,
                                    position_index=position_index + len(results),
                                ),
                                raw_metadata={"source": "html_list_item", "tag": "li"},
                            )
                        )
                except Exception:
                    logger.exception(
                        "Failed to extract list item",
                        extra={"section": current_section},
                    )
                    continue

        # Also extract any images nested in container elements
        if tag_name not in _TEXT_TAGS and tag_name != "img":
            for img in element.find_all("img", recursive=True):
                try:
                    img_element = self._extract_image(
                        img, current_section, position_index + len(results)
                    )
                    if img_element:
                        results.append(img_element)
                except Exception:
                    logger.exception(
                        "Failed to extract nested image",
                        extra={"section": current_section},
                    )
                    continue

        return results, current_section

    def _extract_image(
        self, img_tag: Tag, current_section: str, position_index: int
    ) -> RawElement | None:
        """Extract image content from an <img> tag.

        For base64-encoded images, stores the decoded binary data.
        For URL references, stores the src URL as string content.

        Args:
            img_tag: A BeautifulSoup <img> Tag.
            current_section: The current heading section name.
            position_index: Current position index.

        Returns:
            A RawElement for the image, or None if no src attribute.
        """
        src = img_tag.get("src", "")
        if not src:
            return None

        alt_text = img_tag.get("alt", "")

        # Handle base64-encoded images
        if src.startswith("data:"):
            match = re.match(r"data:([^;]+);base64,(.+)", src)
            if match:
                content_type = match.group(1)
                try:
                    image_data = base64.b64decode(match.group(2))
                    return RawElement(
                        content=image_data,
                        element_type=ElementType.IMAGE,
                        provenance=Provenance(
                            section=current_section,
                            position_index=position_index,
                        ),
                        raw_metadata={
                            "source": "html_image_base64",
                            "content_type": content_type,
                            "alt": alt_text,
                        },
                    )
                except Exception:
                    logger.exception(
                        "Failed to decode base64 image",
                        extra={"section": current_section},
                    )
                    return None

        # URL-referenced image — store the src as string content
        return RawElement(
            content=src,
            element_type=ElementType.IMAGE,
            provenance=Provenance(
                section=current_section,
                position_index=position_index,
            ),
            raw_metadata={
                "source": "html_image_url",
                "src": src,
                "alt": alt_text,
            },
        )

    def _extract_table(
        self, table_tag: Tag, current_section: str, position_index: int
    ) -> RawElement | None:
        """Extract table content as a formatted string.

        Args:
            table_tag: A BeautifulSoup <table> Tag.
            current_section: The current heading section name.
            position_index: Current position index.

        Returns:
            A RawElement for the table, or None if the table is empty.
        """
        rows: list[str] = []

        for tr in table_tag.find_all("tr"):
            cells = []
            for cell in tr.find_all(["th", "td"]):
                cells.append(cell.get_text(strip=True))
            if cells:
                rows.append("\t".join(cells))

        table_content = "\n".join(rows)
        if not table_content.strip():
            return None

        return RawElement(
            content=table_content,
            element_type=ElementType.TABLE,
            provenance=Provenance(
                section=current_section,
                position_index=position_index,
            ),
            raw_metadata={"source": "html_table"},
        )
