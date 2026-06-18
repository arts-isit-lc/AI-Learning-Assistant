"""
In-Memory Document Processing Module

Extracts text and chunks documents entirely in memory without intermediate
S3 storage. Eliminates the 3N S3 API calls per file (upload, download, delete
per page) from the original pipeline.

Requirements validated: 6.1, 6.2, 6.3, 6.4, 15.1
"""

import hashlib
import os
import re
import uuid
from typing import List, Tuple

import fitz
from aws_lambda_powertools import Logger
from langchain_core.documents import Document
from langchain_experimental.text_splitter import SemanticChunker
from langchain_text_splitters import RecursiveCharacterTextSplitter

logger = Logger(service="data-ingestion")

# Page boundary marker used to track page transitions in concatenated text
PAGE_BREAK_MARKER = "\n\n[PAGE_BREAK]\n\n"

# Batch size for streaming fallback when MemoryError is caught
STREAMING_BATCH_SIZE = 50

# Minimum character threshold for OCR fallback (same as existing logic)
OCR_CHAR_THRESHOLD = 30


def _get_text_splitter(strategy: str, embeddings, chunk_size: int, chunk_overlap: int):
    """Return the appropriate text splitter based on the selected strategy.

    Args:
        strategy: Either "semantic" or "recursive".
        embeddings: Embedding model instance (used only for SemanticChunker).
        chunk_size: Maximum chunk size in characters (used only for recursive strategy).
        chunk_overlap: Overlap between chunks in characters (used only for recursive strategy).

    Returns:
        A text splitter instance ready for use.
    """
    if strategy == "recursive":
        return RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", ". ", " ", ""],
        )
    else:  # "semantic" (default)
        return SemanticChunker(embeddings)


def clean_text(text: str) -> str:
    """Remove non-ASCII characters, collapse whitespace, and filter noise.

    Matches the cleaning logic in documents.py for consistency.
    """
    text = text.encode("ascii", errors="ignore").decode()
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) < 20 or len(text.split()) < 3:
        return ""
    return text


def _extract_page_text(page, page_num: int, filename: str) -> str:
    """Extract text from a single PyMuPDF page with OCR fallback.

    Args:
        page: A fitz.Page object.
        page_num: 1-indexed page number for logging.
        filename: Original filename for log context.

    Returns:
        Extracted text string (may be empty if extraction fails).
    """
    text = page.get_text().strip()

    if len(text) < OCR_CHAR_THRESHOLD:
        try:
            tessdata_path = os.environ.get("TESSDATA_PREFIX", "/usr/share/tessdata")
            tp = page.get_textpage_ocr(tessdata=tessdata_path)
            raw_text = tp.extractText()
            lines = raw_text.split("\n")
            cleaned_lines = [clean_text(line) for line in lines if clean_text(line)]
            text = "\n".join(cleaned_lines)
            logger.info("OCR used for page extraction", extra={
                "page_num": page_num,
                "file_name": filename,
            })
        except Exception as e:
            logger.warning("OCR failed on page", extra={
                "page_num": page_num,
                "file_name": filename,
                "error": str(e),
            })
            text = ""

    return text.strip()


def _determine_file_type(filename: str) -> str:
    """Extract the file extension for PyMuPDF filetype parameter.

    Args:
        filename: Original filename (e.g., 'lecture.pdf').

    Returns:
        Lowercase file extension (e.g., 'pdf').
    """
    if "." in filename:
        return filename.rsplit(".", 1)[1].lower()
    return "pdf"


def _compute_page_boundaries(page_texts: List[str]) -> List[int]:
    """Compute character offsets where each page starts in the concatenated text.

    Args:
        page_texts: List of (page_number, text) pairs — but we receive just
                    the boundary positions based on the concatenated output.

    Returns:
        List of character positions marking the start of each page's text
        in the full concatenated string.
    """
    boundaries = []
    offset = 0
    marker_len = len(PAGE_BREAK_MARKER)

    for i, text in enumerate(page_texts):
        boundaries.append(offset)
        offset += len(text)
        if i < len(page_texts) - 1:
            offset += marker_len

    return boundaries


def _resolve_chunk_pages(
    chunk_start: int,
    chunk_end: int,
    page_boundaries: List[int],
    page_numbers: List[int],
) -> List[int]:
    """Determine which page(s) a chunk overlaps with.

    Args:
        chunk_start: Start character position of the chunk in concatenated text.
        chunk_end: End character position of the chunk in concatenated text.
        page_boundaries: List of start positions for each page.
        page_numbers: List of actual page numbers (1-indexed).

    Returns:
        Sorted list of page numbers that the chunk spans.
    """
    overlapping_pages = []

    for i, boundary_start in enumerate(page_boundaries):
        # Determine this page's end position
        if i + 1 < len(page_boundaries):
            boundary_end = page_boundaries[i + 1]
        else:
            boundary_end = float("inf")

        # Check overlap: chunk overlaps this page if chunk starts before page ends
        # AND chunk ends after page starts
        if chunk_start < boundary_end and chunk_end > boundary_start:
            overlapping_pages.append(page_numbers[i])

    return sorted(overlapping_pages) if overlapping_pages else page_numbers[:1]


def process_file_in_memory(
    file_bytes: bytes,
    file_id: str,
    filename: str,
    embeddings,
    bucket: str = None,
    chunking_strategy: str = None,  # "semantic" or "recursive", reads from env if None
    chunk_size: int = None,  # for recursive strategy, reads from env if None
    chunk_overlap: int = None,  # for recursive strategy, reads from env if None
) -> Tuple[List[Document], str]:
    """Process a file entirely in memory without intermediate S3 storage.

    Downloads file from S3 exactly once (caller provides bytes), extracts all
    page text in memory, concatenates with page boundary markers for cross-page
    aware chunking, and returns chunks ready for embedding plus the full text
    for topic extraction reuse.

    Implements a streaming fallback: if MemoryError is caught during full-document
    processing, falls back to processing pages in batches of 50.

    The chunking strategy is configurable via parameters or environment variables:
    - CHUNKING_STRATEGY: "semantic" (default) or "recursive"
    - CHUNK_SIZE: chunk size for recursive strategy (default: 1000)
    - CHUNK_OVERLAP: chunk overlap for recursive strategy (default: 100)

    When "recursive" is selected, RecursiveCharacterTextSplitter is used instead
    of SemanticChunker, making ZERO Bedrock API calls for chunking decisions
    (only the final embedding calls remain).

    Args:
        file_bytes: Raw file content bytes (already downloaded from S3).
        file_id: Mandatory UUID from Module_Files for chunk metadata.
        filename: Original filename (e.g., 'lecture-notes.pdf').
        embeddings: Embedding model instance for SemanticChunker.
        bucket: Optional S3 bucket name for source metadata.
        chunking_strategy: "semantic" or "recursive". Reads CHUNKING_STRATEGY env if None.
        chunk_size: Chunk size for recursive strategy. Reads CHUNK_SIZE env if None.
        chunk_overlap: Chunk overlap for recursive strategy. Reads CHUNK_OVERLAP env if None.

    Returns:
        Tuple of (chunks, full_text):
            - chunks: List[Document] with mandatory metadata set.
            - full_text: Concatenated document text for topic extraction reuse.

    Raises:
        ValueError: If file_id is None or empty.
    """
    if not file_id:
        raise ValueError("file_id is mandatory for process_file_in_memory")

    # Resolve chunking configuration from parameters or environment variables
    if chunking_strategy is None:
        chunking_strategy = os.environ.get("CHUNKING_STRATEGY", "semantic")
    if chunk_size is None:
        chunk_size = int(os.environ.get("CHUNK_SIZE", "1000"))
    if chunk_overlap is None:
        chunk_overlap = int(os.environ.get("CHUNK_OVERLAP", "100"))

    file_type = _determine_file_type(filename)
    source = f"s3://{bucket}/{filename}" if bucket else filename

    logger.info("Starting in-memory processing", extra={
        "file_id": file_id,
        "file_name": filename,
        "chunking_strategy": chunking_strategy,
        "chunk_size": chunk_size,
        "chunk_overlap": chunk_overlap,
    })

    try:
        return _process_full_document(
            file_bytes=file_bytes,
            file_type=file_type,
            file_id=file_id,
            filename=filename,
            embeddings=embeddings,
            source=source,
            chunking_strategy=chunking_strategy,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
    except MemoryError:
        logger.warning(
            "MemoryError during full-document processing, falling back to batch mode",
            extra={"file_id": file_id, "file_name": filename},
        )
        return _process_in_batches(
            file_bytes=file_bytes,
            file_type=file_type,
            file_id=file_id,
            filename=filename,
            embeddings=embeddings,
            source=source,
            chunking_strategy=chunking_strategy,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )


def _process_full_document(
    file_bytes: bytes,
    file_type: str,
    file_id: str,
    filename: str,
    embeddings,
    source: str,
    chunking_strategy: str = "semantic",
    chunk_size: int = 1000,
    chunk_overlap: int = 100,
) -> Tuple[List[Document], str]:
    """Process the entire document in memory (normal path).

    Extracts all pages, concatenates with boundary markers, chunks the full
    text cross-page-aware, and assigns metadata to each chunk.

    Args:
        file_bytes: Raw file bytes.
        file_type: File extension (e.g., 'pdf').
        file_id: UUID for chunk metadata.
        filename: Original filename.
        embeddings: Embedding model for SemanticChunker.
        source: S3 source URI for metadata.
        chunking_strategy: "semantic" or "recursive".
        chunk_size: Chunk size for recursive strategy.
        chunk_overlap: Chunk overlap for recursive strategy.

    Returns:
        Tuple of (chunks, full_text).
    """
    doc = fitz.open(stream=file_bytes, filetype=file_type)

    page_texts = []
    page_numbers = []

    for page_num, page in enumerate(doc, start=1):
        text = _extract_page_text(page, page_num, filename)
        if text:
            page_texts.append(text)
            page_numbers.append(page_num)

    doc.close()

    if not page_texts:
        logger.info("No text extracted from document", extra={"file_name": filename})
        return [], ""

    # Concatenate all pages with boundary markers for cross-page chunking
    full_text = PAGE_BREAK_MARKER.join(page_texts)

    # Compute page boundary offsets in the concatenated text
    page_boundaries = _compute_page_boundaries(page_texts)

    # Chunk the full concatenated document (cross-page aware)
    text_splitter = _get_text_splitter(chunking_strategy, embeddings, chunk_size, chunk_overlap)
    doc_chunks = text_splitter.create_documents([full_text])

    # Filter empty chunks
    doc_chunks = [chunk for chunk in doc_chunks if chunk.page_content.strip()]

    # Assign mandatory metadata to each chunk
    doc_id = str(uuid.uuid4())
    chunks = _assign_chunk_metadata(
        doc_chunks=doc_chunks,
        full_text=full_text,
        page_boundaries=page_boundaries,
        page_numbers=page_numbers,
        file_id=file_id,
        source=source,
        doc_id=doc_id,
    )

    logger.info("In-memory processing complete", extra={
        "file_name": filename,
        "file_id": file_id,
        "page_count": len(page_texts),
        "chunk_count": len(chunks),
    })

    return chunks, full_text


def _process_in_batches(
    file_bytes: bytes,
    file_type: str,
    file_id: str,
    filename: str,
    embeddings,
    source: str,
    chunking_strategy: str = "semantic",
    chunk_size: int = 1000,
    chunk_overlap: int = 100,
) -> Tuple[List[Document], str]:
    """Streaming fallback: process pages in batches of STREAMING_BATCH_SIZE.

    Used when full-document processing triggers a MemoryError. Processes pages
    in smaller batches, chunking each batch separately. This sacrifices some
    cross-page awareness at batch boundaries but prevents OOM failures.

    Args:
        file_bytes: Raw file bytes.
        file_type: File extension (e.g., 'pdf').
        file_id: UUID for chunk metadata.
        filename: Original filename.
        embeddings: Embedding model for SemanticChunker.
        source: S3 source URI for metadata.
        chunking_strategy: "semantic" or "recursive".
        chunk_size: Chunk size for recursive strategy.
        chunk_overlap: Chunk overlap for recursive strategy.

    Returns:
        Tuple of (chunks, full_text).
    """
    doc = fitz.open(stream=file_bytes, filetype=file_type)

    # Extract all page texts first (lighter memory than full chunking)
    all_page_texts = []
    all_page_numbers = []

    for page_num, page in enumerate(doc, start=1):
        text = _extract_page_text(page, page_num, filename)
        if text:
            all_page_texts.append(text)
            all_page_numbers.append(page_num)

    doc.close()

    if not all_page_texts:
        logger.info("No text extracted from document (batch mode)", extra={"file_name": filename})
        return [], ""

    # Build full text for topic extraction reuse
    full_text = PAGE_BREAK_MARKER.join(all_page_texts)

    # Process in batches
    all_chunks: List[Document] = []
    text_splitter = _get_text_splitter(chunking_strategy, embeddings, chunk_size, chunk_overlap)
    total_chunk_index = 0

    for batch_start in range(0, len(all_page_texts), STREAMING_BATCH_SIZE):
        batch_end = min(batch_start + STREAMING_BATCH_SIZE, len(all_page_texts))
        batch_texts = all_page_texts[batch_start:batch_end]
        batch_page_numbers = all_page_numbers[batch_start:batch_end]

        batch_concatenated = PAGE_BREAK_MARKER.join(batch_texts)
        batch_boundaries = _compute_page_boundaries(batch_texts)

        doc_id = str(uuid.uuid4())
        batch_chunks = text_splitter.create_documents([batch_concatenated])
        batch_chunks = [chunk for chunk in batch_chunks if chunk.page_content.strip()]

        # Assign metadata with global chunk_index offset
        for chunk in batch_chunks:
            chunk_start = batch_concatenated.find(chunk.page_content)
            chunk_end = chunk_start + len(chunk.page_content) if chunk_start >= 0 else 0

            chunk_pages = _resolve_chunk_pages(
                chunk_start, chunk_end, batch_boundaries, batch_page_numbers
            )

            content_hash = hashlib.sha256(chunk.page_content.encode("utf-8")).hexdigest()
            chunk.metadata["file_id"] = file_id
            chunk.metadata["source"] = source
            chunk.metadata["doc_id"] = doc_id
            chunk.metadata["page_numbers"] = chunk_pages
            chunk.metadata["chunk_index"] = total_chunk_index
            chunk.metadata["content_hash"] = content_hash
            total_chunk_index += 1

        all_chunks.extend(batch_chunks)

        logger.info("Batch processing progress", extra={
            "file_name": filename,
            "batch_start_page": batch_page_numbers[0] if batch_page_numbers else 0,
            "batch_end_page": batch_page_numbers[-1] if batch_page_numbers else 0,
            "batch_chunks": len(batch_chunks),
        })

    logger.info("Batch in-memory processing complete", extra={
        "file_name": filename,
        "file_id": file_id,
        "page_count": len(all_page_texts),
        "chunk_count": len(all_chunks),
    })

    return all_chunks, full_text


def _assign_chunk_metadata(
    doc_chunks: List[Document],
    full_text: str,
    page_boundaries: List[int],
    page_numbers: List[int],
    file_id: str,
    source: str,
    doc_id: str,
) -> List[Document]:
    """Assign mandatory metadata to each chunk including page_numbers tracking.

    For each chunk, determines which pages it overlaps by finding its position
    in the concatenated full text and comparing against page boundaries.

    Args:
        doc_chunks: Raw chunks from the text splitter.
        full_text: Full concatenated document text.
        page_boundaries: Character offsets where each page starts.
        page_numbers: 1-indexed page numbers corresponding to boundaries.
        file_id: Mandatory file identifier.
        source: S3 source URI.
        doc_id: UUID for this document processing run.

    Returns:
        List of Document chunks with complete metadata.
    """
    chunks = []
    search_start = 0

    for idx, chunk in enumerate(doc_chunks):
        content = chunk.page_content

        # Find chunk position in full text (search forward to handle duplicates)
        chunk_start = full_text.find(content, search_start)
        if chunk_start == -1:
            # Fallback: search from beginning if not found after search_start
            chunk_start = full_text.find(content)

        if chunk_start >= 0:
            chunk_end = chunk_start + len(content)
            search_start = chunk_end
        else:
            # Cannot locate chunk in full text — assign first page as fallback
            chunk_start = 0
            chunk_end = 0

        chunk_pages = _resolve_chunk_pages(
            chunk_start, chunk_end, page_boundaries, page_numbers
        )

        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

        chunk.metadata["file_id"] = file_id
        chunk.metadata["source"] = source
        chunk.metadata["doc_id"] = doc_id
        chunk.metadata["page_numbers"] = chunk_pages
        chunk.metadata["chunk_index"] = idx
        chunk.metadata["content_hash"] = content_hash

        chunks.append(chunk)

    return chunks
