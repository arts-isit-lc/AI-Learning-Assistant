# Data Ingestion Pipeline (Technical Deep-Dive)

This document explains **Layer 1 (Ingestion)** of the multimodal RAG v2 system — how an uploaded course file is turned into a structured, normalized, versioned **Document IR** (Intermediate Representation) and saved, ready for the enrichment layer. It covers every supported file type, the exact data models, and how the parsed data is structured and stored.

Source: `cdk/multimodal_rag_v2/ingestion/`, `models/data_models.py`, `persistence/ir_persistence.py`.

> For the plain-language version, see [Data Ingestion — Explained Simply](./data-ingestion-explained.md). For the layers that come after ingestion, see [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md).

---

## What ingestion does (in one sentence)

> An S3 upload event fires the ingestion Lambda, which routes the file to a format-specific **adapter** that extracts raw content elements (text, images, tables, formulas), normalizes and de-duplicates them into a **DocumentIR**, saves that IR as versioned JSON in S3 (plus extracted images as separate S3 objects), and enqueues an SQS message so the enrichment layer can pick up.

```
S3 ObjectCreated ─▶ ragIngestionFunction ─▶ AdapterRegistry ─▶ IRBuilder ─▶ IRPersistence ─▶ SQS (enrichment)
   (courses/...)      handler.py              per-format         normalize     document_ir.json   {course,module,file,ir_version}
                                              extraction         + dedup       + images/*.png
```

---

## Trigger & the S3 key convention

- **Trigger:** an S3 `ObjectCreated` event on the `courses/` prefix. The event can carry multiple `Records`; each is processed independently.
- **Key format (strict):** `courses/{course_id}/{module_id}/{filename}`. The handler URL-decodes the key (`urllib.parse.unquote_plus`) and splits it. A key that doesn't match returns HTTP 400 (`ValueError`).
- **`file_id`** = filename without its extension (`os.path.splitext`).
- **`extension`** = the lowercased suffix without the dot — this is what selects the adapter.

From the parsed key, the handler builds a **`FileMetadata`** record that travels with the file through the whole pipeline:

| Field | Type | Source |
|---|---|---|
| `course_id` | str | key part 1 |
| `module_id` | str | key part 2 |
| `file_id` | str | filename minus extension |
| `file_key` | str | full S3 key |
| `file_size` | int | S3 event `object.size` |
| `extension` | str | lowercased file extension |

---

## End-to-end handler flow (`ingestion/handler.py`)

For each S3 record, `_process_record` runs these steps (each wrapped in an X-Ray subsegment and timed):

```
1. Parse bucket + key from the event  (URL-decode the key)
2. _parse_s3_key → course_id, module_id, file_id, filename, extension
3. Build FileMetadata
4. _download_file      → raw bytes           (S3 GetObject)          [S3Download]
5. registry.process_file(bytes, metadata) → list[RawElement]         [AdapterExtraction]
6. ir_builder.build(raw_elements, metadata) → DocumentIR             [IRBuild]
7. _upload_images_to_s3(document_ir, ...)  → images/*.png in S3      [ImageUpload]
8. ir_persistence.persist(document_ir)     → document_ir.json in S3  [IRPersist]
9. SQS send_message → enrichment queue  {course, module, file, ir_version}
10. Return { statusCode: 200, file_id, ir_s3_path, element_count }
```

The handler emits a structured `Ingestion complete` log with a per-phase latency breakdown (`download_latency_ms`, `adapter_latency_ms`, `ir_build_latency_ms`, `image_upload_latency_ms`, `persist_latency_ms`, `total_latency_ms`).

---

## Format detection & the Adapter Registry

Routing is **extension-based** (`ingestion/adapter_registry.py`). At module load the handler registers one adapter instance per extension:

| Extensions | Adapter | Library |
|---|---|---|
| `pdf` | `PdfAdapter` | PyMuPDF (`fitz`) |
| `pptx` | `PptxAdapter` | `python-pptx` |
| `docx` | `DocxAdapter` | `python-docx` |
| `html`, `htm` | `HtmlAdapter` | `beautifulsoup4` |
| `png`, `jpeg`, `jpg`, `gif`, `tiff`, `tif`, `bmp`, `webp` | `ImageAdapter` | (raw bytes) |
| `tex`, `latex` | `LatexAdapter` | `pylatexenc` |
| `csv` | `CsvAdapter` | stdlib `csv` |
| `json` | `JsonAdapter` | stdlib `json` |

`AdapterRegistry.process_file` is the entry point and enforces order:

1. **Size gate first** — `validate_file_size` rejects anything over **200 MB** (`MAX_FILE_SIZE_BYTES`) *before* any parsing, raising `FileSizeExceededError`. It trusts `FileMetadata.file_size` (from the S3 event), falling back to `len(file_content)`.
2. **Resolve adapter** — `get_adapter(file_key)` looks up the lowercased extension; unknown/missing → `UnsupportedFormatError`.
3. **Extract** — `adapter.extract(file_content, file_metadata)` returns `list[RawElement]`.

Every adapter implements the `BaseAdapter.extract(file_content, file_metadata) -> list[RawElement]` contract.

---

## The data model (single source of truth: `models/data_models.py`)

Ingestion uses three element shapes that flow in sequence, plus two enums/records:

```
adapter output          normalized              persisted document
┌────────────┐  IRBuilder ┌────────────┐        ┌──────────────────────┐
│ RawElement │──────────▶ │ IRElement  │───────▶│      DocumentIR      │
└────────────┘  dedup +   └────────────┘ collect└──────────────────────┘
                hash + id                          file_metadata
                                                   elements: [IRElement]
                                                   element_count: {type: n}
                                                   ir_version
```

### `ElementType` (enum)

```
TEXT · IMAGE · TABLE · FORMULA
```

Every extracted element is exactly one of these four types.

### `Provenance` — where an element came from

| Field | Type | Meaning |
|---|---|---|
| `page_num` | int \| None | 1-based page (PDF; also set to 1 by CSV/JSON/LaTeX/standalone image) |
| `slide_num` | int \| None | 1-based slide (PPTX) |
| `section` | str \| None | heading/section name (DOCX, HTML) |
| `position_index` | int | order within the page/slide/section |

Different formats populate different provenance fields — PDFs use `page_num`, slides use `slide_num`, Word/HTML use `section`. This is how each element "knows where it lives."

### `RawElement` — raw adapter output (pre-normalization)

| Field | Type |
|---|---|
| `content` | `bytes \| str` (bytes for images, str for text/table/formula) |
| `element_type` | `ElementType` |
| `provenance` | `Provenance` |
| `raw_metadata` | `dict` (adapter-specific: `source`, `width`/`height`, `style`, `content_type`, …) |

### `IRElement` — normalized element (post-IRBuilder)

| Field | Type | Notes |
|---|---|---|
| `element_id` | str | `SHA256(content_bytes + provenance_str)` — stable identity |
| `content` | `bytes \| str` | same content |
| `element_type` | `ElementType` | |
| `provenance` | `Provenance` | |
| `content_hash` | str | `SHA256(content_bytes)` — used for de-duplication |
| `metadata` | dict | carried from `raw_metadata`; later gains `image_s3_key` for images |

### `DocumentIR` — the whole parsed document

| Field | Type | Notes |
|---|---|---|
| `file_metadata` | `FileMetadata` | who/where this file is |
| `elements` | `list[IRElement]` | de-duplicated, provenance-sorted |
| `element_count` | `dict[ElementType, int]` | tally per type |
| `ir_version` | str | `IR_VERSION` = **`ir-v1`** |

---

## Per-adapter extraction details

All adapters degrade gracefully: a failure on one page/slide/shape/element is logged and skipped so the rest of the document still processes.

### PDF — `PdfAdapter` (PyMuPDF / `fitz`)

The richest adapter. Opens from bytes; iterates pages (a page that throws is skipped). Per page, in `position_index` order:

- **Text blocks** — `page.get_text("blocks")`, keeping only `block_type == 0` (text). Each non-empty block is scanned with a **LaTeX regex** (`\frac`, `\sqrt`, `\begin{equation}`, `$…$`, `\[…\]`, etc.); a match makes it a **FORMULA**, otherwise **TEXT**.
- **Images** — `page.get_images(full=True)` → `extract_image(xref)`. Images below **100×100 px** are dropped; non-PNG is converted to PNG (via `fitz.Pixmap`, flattening alpha). Stored as **IMAGE** with `width`/`height`/`original_format` metadata.
- **Tables** — `page.find_tables()` (fitz ≥ 1.23) → each table serialized as pipe-separated rows (`cell | cell`), stored as **TABLE**.
- **Vector-graphics fallback** — if a page has **no raster images** but **> 5 drawing operations** (`page.get_drawings()`), the whole page is rendered to PNG at **2× resolution** and stored as an **IMAGE** (`source: pdf_page_render`). This captures diagrams/charts drawn as vectors.

### PPTX — `PptxAdapter` (`python-pptx`)

Iterates slides (`slide_num` = 1-based). Per shape:

- **Table** (`shape.has_table`) → tab-separated rows → **TABLE**.
- **Picture** (`shape_type == MSO_SHAPE_TYPE.PICTURE`) → `shape.image.blob` → **IMAGE** (with `content_type`).
- **Text frame** (`shape.has_text_frame`) → paragraphs joined by newline → **TEXT**.

Provenance uses `slide_num` + `position_index`.

### DOCX — `DocxAdapter` (`python-docx`)

Tracks the **current section** from `Heading 1`–`Heading 6` paragraph styles.

- **Paragraphs** → **TEXT** (with `style` in metadata); heading paragraphs update `section`.
- **Inline images** → walked out of each run's XML (`drawing → inline → blip`, resolving the `embed` relationship to `target_part.blob`) → **IMAGE**.
- **Tables** (`document.tables`) → tab-separated rows → **TABLE**.

Provenance uses `section` + `position_index`.

### HTML — `HtmlAdapter` (`beautifulsoup4`)

Strips `<script>`/`<style>`, walks the `<body>`, tracks `section` from `h1`–`h6`.

- **Text tags** (`p, h1–h6, li, blockquote, pre, dd, dt`) → **TEXT**.
- **Tables** → tab-separated rows → **TABLE**.
- **Images:**
  - `data:` base64 URIs → decoded bytes → **IMAGE** (`content_type`, `alt`).
  - **External URL images are NOT fetched** (deliberate — SSRF risk, latency, reliability). Instead, if `alt` text exists it becomes a searchable **TEXT** element (`"Image: {alt}"`); with no alt text the image is skipped.
- Recurses into containers (`div, section, article, main, aside, nav, header, footer, figure`) and extracts nested `<img>`/lists.

Provenance uses `section` + `position_index`.

### LaTeX — `LatexAdapter` (`pylatexenc`)

Decodes UTF-8 (empty/undecodable → `ExtractionFailureError`), builds a node tree with `LatexWalker`, and walks it:

- **Math nodes** (`LatexMathNode`) and **math environments** (`equation`, `equation*`, `align`, `gather`, `multline`, `displaymath`, `eqnarray`, …) → **FORMULA** (raw LaTeX preserved).
- **Tabular environments** (`tabular`, `tabular*`, `array`, `longtable`, `tabularx`) → **TABLE** via a heuristic converter (strips `\begin/\end`, drops the column spec, splits rows on `\\`, cells on unescaped `&`, removes rules/formatting).
- **Text** nodes are buffered and flushed into **TEXT** elements.
- **Figures** (`figure`, `wrapfigure`, …) and bare `\includegraphics` → a searchable **TEXT** reference built from `\caption` + `\label` + filename. **Image bytes are not fetched** (they're external to the `.tex` source).

All elements get `page_num=1` (LaTeX has no pages at parse time) + incrementing `position_index`.

### CSV — `CsvAdapter` (stdlib `csv`)

The entire file becomes **one TABLE element** holding the **raw CSV text** (validated as parseable). Metadata records `row_count`, `column_count`, and `has_header: true` (first row assumed to be the header by convention). Provenance: `page_num=1, position_index=0`.

### JSON — `JsonAdapter` (stdlib `json`)

Structure-aware:

- **Array of objects sharing a common key set** → **TABLE** (raw JSON text as content; `row_count`/`column_count`/`structure: array_of_objects` metadata).
- **Anything else** → **TEXT** (pretty-printed with `indent=2`).

Provenance: `page_num=1, position_index=0`. Empty/invalid JSON → `ExtractionFailureError`.

### Images — `ImageAdapter` (standalone image files)

A standalone `png/jpeg/jpg/gif/tiff/tif/bmp/webp` becomes a **single IMAGE element** with the raw bytes. **No size filtering** here (the 100×100 filter applies only to images embedded inside multi-element documents like PDFs). Provenance: `page_num=1, position_index=0`.

### Summary: which types each adapter emits

| Adapter | TEXT | IMAGE | TABLE | FORMULA | Location field |
|---|:---:|:---:|:---:|:---:|---|
| PDF | ✅ | ✅ | ✅ | ✅ (regex) | `page_num` |
| PPTX | ✅ | ✅ | ✅ | — | `slide_num` |
| DOCX | ✅ | ✅ | ✅ | — | `section` |
| HTML | ✅ | ✅ (base64) | ✅ | — | `section` |
| LaTeX | ✅ | — (as TEXT ref) | ✅ | ✅ | `page_num=1` |
| CSV | — | — | ✅ | — | `page_num=1` |
| JSON | ✅ | — | ✅ | — | `page_num=1` |
| Image | — | ✅ | — | — | `page_num=1` |

---

## Normalization — `IRBuilder.build`

`IRBuilder` turns `list[RawElement]` into a clean `DocumentIR`:

1. **Small-image filter** — IMAGE elements with `width`/`height` metadata below **100×100 px** are dropped (if dimensions are absent, the element is kept).
2. **Hashing & identity** — for each element:
   - `content_hash = SHA256(content_bytes)`
   - `element_id = SHA256(content_bytes + provenance_str)` where `provenance_str = "{page_num}:{slide_num}:{section}:{position_index}"`
3. **De-duplication** — the first element for a given `content_hash` wins; later duplicates are discarded (repeated logos, headers, boilerplate).
4. **Ordering** — elements are sorted by `(page_num, slide_num, position_index)` so reading order is preserved.
5. **Counting** — `element_count` is a `Counter` over `ElementType`.

A total failure raises `ExtractionFailureError`; otherwise it logs an `IR build summary` (raw vs. final counts, dedup count, filtered-small count, per-type breakdown, max page).

---

## How the data is saved

Ingestion writes to the **IR bucket** (S3) in two places, then hands off via SQS.

### 1. Extracted images → S3 objects

`_upload_images_to_s3` uploads each IMAGE element's bytes to:

```
s3://{IR_BUCKET_NAME}/images/{course_id}/{module_id}/{element_id}.png     (ContentType: image/png)
```

The resulting URI is written back onto the element as `metadata["image_s3_key"] = "s3://…"`. Enrichment and retrieval later use this key for **image escalation** (sending the actual image to a vision model at query time). This step is best-effort — a failed image upload is logged and skipped.

### 2. The DocumentIR → versioned JSON

`IRPersistence.persist` serializes the whole `DocumentIR` to JSON and writes it to:

```
s3://{IR_BUCKET_NAME}/{course_id}/{module_id}/{file_id}/ir_v{ir_version}/document_ir.json
```

With `ir_version = "ir-v1"`, the concrete path segment is `ir_vir-v1/`. The object is written with `ContentType: application/json` and `ServerSideEncryption: AES256`.

**Serialization rules:**
- Each element → `{ element_id, content, content_is_binary, element_type (string), provenance (dict), content_hash, metadata }`.
- **Binary content (images)** is **base64-encoded** and flagged with `content_is_binary: true`; text/table/formula content is stored as-is.
- `element_type` is stored as its string value (`"text"`, `"image"`, …); `element_count` keys are stringified too.

**Example `document_ir.json` (abridged):**

```json
{
  "file_metadata": {
    "course_id": "course-101", "module_id": "module-3",
    "file_id": "lecture-05", "file_key": "courses/course-101/module-3/lecture-05.pdf",
    "file_size": 2489173, "extension": "pdf"
  },
  "elements": [
    {
      "element_id": "9f2c…a1", "content": "A binary search tree is…",
      "content_is_binary": false, "element_type": "text",
      "provenance": { "page_num": 1, "slide_num": null, "section": null, "position_index": 0 },
      "content_hash": "3b1e…", "metadata": { "source": "pdf_text_block" }
    },
    {
      "element_id": "7d4a…c9", "content": "iVBORw0KGgoAAAANSUhEUg…",
      "content_is_binary": true, "element_type": "image",
      "provenance": { "page_num": 2, "slide_num": null, "section": null, "position_index": 3 },
      "content_hash": "aa90…",
      "metadata": { "source": "pdf_image", "width": 640, "height": 480,
                    "original_format": "jpeg",
                    "image_s3_key": "s3://ir-bucket/images/course-101/module-3/7d4a…c9.png" }
    }
  ],
  "element_count": { "text": 42, "image": 6, "table": 3, "formula": 5 },
  "ir_version": "ir-v1"
}
```

### 3. SQS handoff to enrichment

If `ENRICHMENT_QUEUE_URL` is set, the handler sends a small pointer message (the IR itself lives in S3):

```json
{ "course_id": "…", "module_id": "…", "file_id": "…", "ir_version": "ir-v1" }
```

The **persisted** `ir_version` is sent (not the code constant) so enrichment loads the exact S3 path even if `IR_VERSION` is bumped later.

---

## Versioning & re-enrichment (why the IR is saved)

Persisting the IR decouples **parsing** from **enrichment**:

- Different `ir_version`s live at **different S3 paths** — versions coexist, nothing is overwritten.
- If enrichment logic improves (new vision model, new chunking), files can be **re-enriched straight from the saved IR** — no re-upload and no re-parsing.
- `IRPersistence.load(course_id, module_id, file_id, ir_version?)` reads it back (defaulting to the current `IR_VERSION`), decoding base64 content back to bytes. Missing objects (`NoSuchKey`/`404`), other S3 errors, and corrupted JSON all raise `IRNotFoundError`.

> Related but separate: `ENRICHMENT_VERSION` (`haiku45-v6-2026-07`) and `EMBEDDING_VERSION` (`titan-v2-1024`) version the *enrichment* layer's caches. Bumping `IR_VERSION` changes how files are *parsed*; those constants change how the IR is *enriched/embedded*.

---

## Error handling & status codes

| Condition | Exception | Handler result |
|---|---|---|
| S3 key not `courses/{c}/{m}/{file}` | `ValueError` | **400** |
| Extension unknown/missing | `UnsupportedFormatError` | **400** |
| File > 200 MB | `FileSizeExceededError` | **400** |
| Adapter/IR build total failure | `ExtractionFailureError` | **500** |
| Anything else | `Exception` | **500** (`Internal error: {type}`) |
| Success | — | **200** (`file_id`, `ir_s3_path`, `element_count`) |

**Two layers of resilience:**
- **Element-level** (inside adapters): a bad page/slide/shape/image/table is logged and skipped; the rest of the document still yields elements. (This is the core V2 improvement over V1, where one bad page killed the whole document.)
- **Record-level** (handler): each S3 record is processed independently; the handler returns 200 unless **every** record failed, in which case it returns the first failure's status.

Best-effort steps (image upload, SQS send) never fail the turn — they log and continue. A missing `ENRICHMENT_QUEUE_URL` just skips the enrichment trigger with a warning.

---

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `IR_BUCKET_NAME` | Destination bucket for `document_ir.json` and extracted `images/*.png` |
| `SOURCE_BUCKET_NAME` | Source bucket (context; the bucket/key also arrive in the S3 event) |
| `ENRICHMENT_QUEUE_URL` | SQS queue that triggers Layer 2 enrichment |

Version constants live in `models/data_models.py`: `IR_VERSION = "ir-v1"`, `ENRICHMENT_VERSION = "haiku45-v6-2026-07"`, `EMBEDDING_VERSION = "titan-v2-1024"`.

---

## Module source files

```
cdk/multimodal_rag_v2/
├── ingestion/
│   ├── handler.py            # S3-event entry point + orchestration + SQS handoff
│   ├── adapter_registry.py   # extension→adapter routing + 200MB size gate
│   ├── ir_builder.py         # RawElement[] → DocumentIR (hash, dedup, sort, count, small-image filter)
│   ├── base_adapter.py       # BaseAdapter.extract() contract
│   ├── exceptions.py         # UnsupportedFormatError, FileSizeExceededError, ExtractionFailureError
│   └── adapters/
│       ├── pdf_adapter.py     # PyMuPDF: text/formula(regex)/image/table + vector-page render
│       ├── pptx_adapter.py    # python-pptx: per-slide text/image/table
│       ├── docx_adapter.py    # python-docx: section-tracked text/inline-image/table
│       ├── html_adapter.py    # BeautifulSoup: text/table/base64-image (URL images → alt text)
│       ├── latex_adapter.py   # pylatexenc: formula/tabular→table/text/figure-ref
│       ├── csv_adapter.py     # stdlib csv: whole file → one TABLE
│       ├── json_adapter.py    # stdlib json: array-of-objects → TABLE, else TEXT
│       └── image_adapter.py   # standalone image file → one IMAGE
├── models/data_models.py     # FileMetadata, Provenance, RawElement, IRElement, DocumentIR, ElementType, versions
└── persistence/
    ├── ir_persistence.py     # DocumentIR ⇄ S3 JSON (base64 binary, AES256, versioned path)
    └── exceptions.py         # IRNotFoundError
```

---

## Related documentation

- [Data Ingestion — Explained Simply](./data-ingestion-explained.md) — the non-technical companion to this doc
- [Multimodal RAG Pipeline](./multimodal-rag-pipeline.md) — the full 4-layer pipeline (ingestion feeds enrichment → retrieval → reasoning)
- [Multimodal RAG V2 — Explained Simply](./multimodal-rag-v2-explained.md) — non-technical overview of the whole RAG system
- [Data Flow](./data-flow.md) — end-to-end journey from upload to a student's answer
