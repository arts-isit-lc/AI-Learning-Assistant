# Image RAG Implementation Plan

This document outlines the incremental steps required to add image understanding to the RAG pipeline — covering both images embedded inside PDFs and standalone image files uploaded by instructors.

---

## Current State Summary

| Layer | What exists today |
|---|---|
| PDF parsing | PyMuPDF (`fitz`) extracts text per page; falls back to Tesseract OCR only when `< 30` characters of text are found |
| Standalone images | Not accepted — `process_documents` only processes `.pdf`, `.docx`, `.pptx`, `.txt`, `.xlsx`, `.xps`, `.mobi`, `.cbz` |
| Embeddings | Text-only via Amazon Bedrock (`BedrockEmbeddings`) into PGVector |
| Retrieval | Hybrid text search (vector + keyword) in `text_generation/src/helpers/vectorstore.py` |
| LLM | `ChatBedrock` — Claude 3 Sonnet is already available and supports vision; Llama 3 70B does **not** support vision |
| Image libraries | `Pillow` is in `data_ingestion/requirements.txt` but unused; `PyMuPDF` is present and capable of extracting images |

The core gap: images are never extracted, never described, and never embedded. They are invisible to the model at query time.

---

## Chosen Approach: Caption-then-Embed

Each image (extracted from a PDF page or uploaded standalone) is passed to a vision-capable model on Amazon Bedrock (Claude 3 Sonnet) to generate a text description/caption. That caption is then embedded and stored in PGVector exactly like a text chunk, with metadata linking it back to its source file. At query time, no changes are needed to the retriever or the LLM call — the caption surfaces as a retrieved document chunk like any other.

This approach was chosen because:
- It requires no changes to the retrieval layer, the vectorstore schema, or the text generation Lambda
- It works with both vision-capable and non-vision LLMs at query time (the caption is plain text)
- It is incremental — each step below is independently deployable and testable

---

## Step 1 — Extract Images from PDFs

**File to modify:** `cdk/data_ingestion/src/processing/documents.py`

PyMuPDF already opens every PDF page. It can also extract embedded images from each page via `page.get_images()` and `doc.extract_image(xref)`. The goal of this step is to pull every image out of every PDF page and save each one as a `.png` to S3 under a new prefix, e.g.:

```
{course}/{module}/extracted_images/{filename}_page_{n}_img_{i}.png
```

Key decisions:
- Skip images smaller than a minimum pixel area (e.g. `width * height < 10000`) to filter out decorative icons, bullets, and borders that carry no educational content
- Store the source PDF filename and page number in the S3 object key so provenance is preserved for metadata later
- This step produces no embeddings yet — it only populates the image staging prefix in S3

**New function signature (to add to `documents.py`):**
```python
def extract_images_from_pdf(
    bucket: str,
    course: str,
    module: str,
    filename: str,
    output_bucket: str,
    min_pixel_area: int = 10000
) -> List[str]:  # returns list of S3 keys for extracted images
```

**Dependencies:** No new dependencies — PyMuPDF and boto3 are already present.

---

## Step 2 — Caption Images Using a Bedrock Vision Model

**New file to create:** `cdk/data_ingestion/src/processing/images.py`

For each image S3 key produced in Step 1 (and for standalone image uploads in Step 4), download the image, base64-encode it, and invoke Claude 3 Sonnet via `bedrock_runtime.invoke_model` using the Messages API with an `image` content block.

The prompt should instruct the model to describe the image in the context of educational material — what it shows, any text visible in it, and what concept it likely illustrates. A concise but complete description (3–6 sentences) is the target output.

**New function signature:**
```python
def caption_image(
    image_bytes: bytes,
    media_type: str,           # e.g. "image/png"
    bedrock_client,
    vision_model_id: str       # e.g. "anthropic.claude-3-sonnet-20240229-v1:0"
) -> str:                      # returns the caption string
```

The caption becomes the `page_content` of a LangChain `Document`. Metadata must include:
- `source` — S3 URI of the original PDF or image file
- `doc_id` — UUID shared across all chunks from the same source file
- `file_id` — the database `file_id` for filtering at retrieval time
- `content_type: "image"` — useful for debugging and future filtering

**Dependencies:** No new dependencies — `boto3` and `langchain-core` are already present. The `Pillow` library already in `requirements.txt` can be used to validate/convert image formats before sending to Bedrock if needed.

**Bedrock model requirement:** The vision model must be enabled in your AWS account. Claude 3 Sonnet (`anthropic.claude-3-sonnet-20240229-v1:0`) is already listed in `llm_models.py` and is vision-capable. Confirm it is enabled in the Bedrock console under **Model access** in your deployment region.

---

## Step 3 — Integrate Image Captions into the Ingestion Pipeline

**File to modify:** `cdk/data_ingestion/src/processing/documents.py`  
**File to modify:** `cdk/data_ingestion/src/helpers/helper.py`

The `add_document` function currently calls `store_doc_texts` then `store_doc_chunks`. A new call to `extract_images_from_pdf` and then `caption_and_chunk_images` needs to be added so that image caption `Document` objects are collected alongside text chunks and passed together into the `index()` call in `process_documents`.

The `bedrock_runtime` client and `vision_model_id` need to be threaded through from `main.py` → `update_vectorstore_from_s3` → `store_module_data` → `process_documents` → `add_document`.

Updated flow in `process_documents`:
```
for each file:
    text_chunks  = add_document(...)          # existing
    image_chunks = add_image_captions(...)    # new
    all_doc_chunks.extend(text_chunks + image_chunks)

index(all_doc_chunks, ...)                    # unchanged
```

The `index()` call with `cleanup="full"` and `source_id_key="source"` already handles deduplication — no changes needed there.

**Environment variable to add:** `VISION_MODEL_ID` (or reuse the existing `BEDROCK_LLM_PARAM` SSM parameter if Claude 3 Sonnet is already stored there). A dedicated SSM parameter is cleaner since the vision model used for captioning is independent of the conversational LLM.

---

## Step 4 — Accept Standalone Image Uploads

**File to modify:** `cdk/data_ingestion/src/processing/documents.py`  
**File to modify:** `cdk/data_ingestion/src/main.py`

Two changes are needed:

**4a. Extend the accepted file type list in `process_documents`:**
```python
# from
if filename.endswith((".pdf", ".docx", ...)):
# to
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif")
if filename.endswith((".pdf", ".docx", ...)):
    # existing text path
elif filename.endswith(IMAGE_EXTENSIONS):
    # new image path — download from S3, caption, chunk, append to all_doc_chunks
```

**4b. Extend `parse_s3_file_path` in `main.py`:**  
The current parser splits on `.` to get `file_type` and assumes a single extension. This already works for `.png`, `.jpg`, etc. — no change needed here as long as filenames don't contain extra dots.

**4c. Frontend upload UI (out of scope for this document):**  
The instructor file upload component will need to accept image MIME types. This is a frontend-only change and does not affect the ingestion Lambda.

---

## Step 5 — Infrastructure Changes

**File to modify:** `cdk/lib/` (whichever stack defines the data ingestion ECS task / Lambda)

The following additions are required:

**5a. Bedrock permissions:**  
The IAM role for the data ingestion container must be granted `bedrock:InvokeModel` for the vision model ARN:
```
arn:aws:bedrock:{region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0
```
This permission likely already exists if the text generation Lambda has it — confirm and replicate to the ingestion role.

**5b. SSM Parameter:**  
Add a new SSM parameter `/aila/vision-model-id` with value `anthropic.claude-3-sonnet-20240229-v1:0`. Pass it as an environment variable `VISION_MODEL_ID` to the data ingestion container.

**5c. Memory/timeout:**  
Captioning images via Bedrock adds latency per image (~1–3 seconds each). If the ingestion container has a tight timeout, increase it. For Lambda-based ingestion, increase the timeout and memory. For ECS-based ingestion, this is less of a concern.

**5d. No vectorstore schema changes:**  
The `langchain_pg_embedding` table stores `cmetadata` as JSONB. The new `content_type: "image"` metadata field requires no schema migration — it is stored automatically alongside existing fields.

---

## Step 6 — Testing

Before deploying, validate each step in isolation using the existing troubleshooting notebook referenced in `troubleshootingGuide.md`.

| Test | What to verify |
|---|---|
| Step 1 | Upload a PDF with diagrams; confirm `.png` files appear in S3 under `extracted_images/` prefix |
| Step 2 | Call `caption_image` directly with a sample image; confirm the returned string is a meaningful description |
| Step 3 | Re-ingest a PDF; query the vectorstore directly and confirm image caption chunks appear with `content_type: "image"` in metadata |
| Step 4 | Upload a standalone `.png` via the instructor UI; confirm it is ingested and retrievable |
| End-to-end | Ask the student chatbot a question that relates to a diagram in the course material; confirm the response references visual content |

---

## Summary of File Changes

| File | Change type | Description |
|---|---|---|
| `data_ingestion/src/processing/documents.py` | Modify | Add `extract_images_from_pdf`; extend `add_document` and `process_documents` to handle images |
| `data_ingestion/src/processing/images.py` | New file | `caption_image` function and `caption_and_chunk_images` orchestrator |
| `data_ingestion/src/helpers/helper.py` | Modify | Thread `bedrock_client` and `vision_model_id` through to `process_documents` |
| `data_ingestion/src/main.py` | Modify | Read `VISION_MODEL_ID` env var; pass Bedrock client and model ID into `update_vectorstore_from_s3` |
| `data_ingestion/requirements.txt` | Modify | No new packages needed; confirm `Pillow` is used (already listed) |
| `cdk/lib/{ingestion-stack}.ts` | Modify | Add SSM parameter, IAM `bedrock:InvokeModel` permission, `VISION_MODEL_ID` env var |

The text generation Lambda (`text_generation/`) requires **no changes**.

---

## What This Does Not Cover

- **Re-ranking image vs. text chunks** at retrieval time — the hybrid search blends them equally by score, which is acceptable for a first version
- **Rendering images in the chat UI** — captions are returned as text; the frontend does not need to display images
- **Video or audio files** — out of scope
- **Image deduplication across uploads** — if the same PDF is re-uploaded, `cleanup="full"` in the `index()` call handles re-indexing, but identical images across different files will each get their own caption
