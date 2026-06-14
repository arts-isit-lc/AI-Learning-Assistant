# MarkItDown — Potential RAG Pipeline Improvement

**Repository:** https://github.com/microsoft/markitdown  
**License:** MIT  
**Status:** Backlog — evaluate when prioritizing RAG quality improvements

## What It Is

MarkItDown is a Python utility by Microsoft's AutoGen team that converts documents (PDF, DOCX, PPTX, XLSX, HTML, images, audio) into structured Markdown. 91k+ GitHub stars, actively maintained.

## Why It's Relevant

Our `data_ingestion` Lambda currently uses PyMuPDF (`fitz`) for page-by-page text extraction with Tesseract OCR fallback. This produces flat plain text. MarkItDown would preserve document structure (headings, tables, lists, links) as Markdown — giving LangChain's `SemanticChunker` richer signals to split on, potentially improving retrieval quality.

## Current Pipeline (for context)

```
S3 upload → data_ingestion Lambda → PyMuPDF text extraction (+ OCR) → per-page .txt → SemanticChunker → PGVector
```

## What Would Change

```
S3 upload → data_ingestion Lambda → MarkItDown conversion → structured Markdown → SemanticChunker → PGVector
```

Affected file: `cdk/data_ingestion/src/processing/documents.py` (specifically `store_doc_texts()` and `extract_txt()`)

## Potential Benefits

- Better chunk quality from preserved document structure
- Native support for all our accepted file types (pdf, docx, pptx, txt, xlsx)
- Tables rendered as Markdown tables instead of garbled text
- Headings preserved — chunker can use them as natural split points
- Less custom code to maintain (replaces PyMuPDF + Tesseract setup)

## Risks / Trade-offs

- Current pipeline works and is deployed — this is a quality improvement, not a bug fix
- Need to verify MarkItDown's PDF extraction quality matches or exceeds PyMuPDF + OCR for scanned documents
- Adds a dependency (though it's lightweight and well-maintained)
- Would need to test with actual course materials to confirm RAG answer quality improves
- OCR support requires the optional `markitdown-ocr` package

## Evaluation Plan

1. Pick 2-3 existing course PDFs (one text-heavy, one with tables, one scanned)
2. Run both pipelines and compare chunk output quality
3. Feed both sets of chunks into the same RAG query and compare answer relevance
4. If quality improves meaningfully, plan migration as a separate spec

## Not Applicable For

- The student PDF viewer feature (that renders the original PDF visually, doesn't need text extraction)
- Real-time chat processing (this is ingestion-time only)
