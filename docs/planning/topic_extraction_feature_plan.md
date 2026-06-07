# Topic Extraction Feature — Design Plan

## Overview

When an instructor uploads a PDF to a module, the system automatically extracts the main topics from that file using Claude 3 Haiku in the background. The instructor can then click a "Generate Topics" button to aggregate topics across all files in the module into a concise, final list. These aggregated topics serve as a reference for the instructor when writing the module prompt, and are used as a fallback in the student chatbot's system prompt when no module-level prompt is present.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Per-File Extraction (automatic, async at upload time)          │
│                                                                         │
│ PDF uploaded → S3 event → data_ingestion Lambda                         │
│   1. insert_file_into_db()                                              │
│   2. get_file_id_from_db()                                              │
│   3. ★ NEW: extract_text_from_pdf() → call_haiku_for_topics()           │
│      → update metadata on Module_Files by file_id (JSONB)               │
│   4. update_vectorstore_from_s3() (existing, unchanged)                 │
│                                                                         │
│ Non-blocking: if step 3 fails, steps 1, 2, 4 still succeed.            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Module-Level Aggregation (manual "Generate Topics" button)     │
│                                                                         │
│ Instructor clicks "Generate Topics" on create/edit module page.         │
│   1. Backend checks if all files have per-file metadata                 │
│   2. If not all ready → return status: "still processing X of Y files"  │
│   3. If all ready → collect per-file topics from DB                     │
│   4. Send combined topic list to Haiku for consolidation                │
│   5. Return final topic list (max 7 topics, no minimum)                 │
│   6. Store result at module level with source_file_ids for staleness    │
│   7. Display to instructor as reference for writing module prompt       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ Layer 3: System Prompt Injection (at chat time)                         │
│                                                                         │
│ When building system prompt in text_generation Lambda:                   │
│   - If NO module prompt exists → inject aggregated topics               │
│   - If module prompt exists → do NOT inject (trust the instructor)      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: Per-File Extraction (data_ingestion Lambda)

### Insertion Point in Pipeline

```python
# In handler(), BEFORE update_vectorstore_from_s3():
#
# 1. insert_file_into_db()        ← existing
# 2. get_file_id_from_db()        ← existing
# 3. extract and store topics     ← NEW (non-blocking)
# 4. update_vectorstore_from_s3() ← existing, unchanged

if event_name.startswith('ObjectCreated:'):
    insert_file_into_db(...)
    file_id = get_file_id_from_db(...)

    # Get S3 ETag from event for idempotency
    s3_etag = record['s3']['object'].get('eTag', '')

    # NEW: Topic extraction (non-blocking, with idempotency)
    try:
        if should_extract_topics(file_id, s3_etag):
            full_text = extract_text_from_pdf(bucket_name, file_key)
            topics = call_haiku_for_topics(full_text)
            update_file_metadata(file_id, topics, s3_etag)
    except Exception as e:
        logger.warning(f"Topic extraction failed (non-blocking): {e}")

    # Existing vectorstore update (unchanged)
    update_vectorstore_from_s3(bucket_name, course_id, module_id, file_id)
```

### New Helper: `extract_text_from_pdf()`

Downloads the single new PDF from S3 and extracts full text using PyMuPDF.
Always extracts all pages first, then decides whether to send in full or sample.

```python
DIRECT_SEND_LIMIT = 160000  # ~40K tokens — send everything below this

def extract_text_from_pdf(bucket: str, file_key: str) -> str:
    """
    Download a PDF from S3 and extract all text content.
    Uses PyMuPDF with OCR fallback for scanned pages.
    If total text exceeds DIRECT_SEND_LIMIT, applies sampling strategy.
    Returns the text to send to the LLM.
    """
    with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
        s3.download_file(bucket, file_key, tmp_file.name)
        doc = fitz.open(tmp_file.name)

        all_pages = []
        total_chars = 0

        for page in doc:
            text = page.get_text().strip()
            if len(text) < 30:
                try:
                    tessdata_path = os.environ.get("TESSDATA_PREFIX", "/usr/share/tessdata")
                    tp = page.get_textpage_ocr(tessdata=tessdata_path)
                    text = tp.extractText()
                except Exception:
                    text = ""
            if text.strip():
                all_pages.append(text)
                total_chars += len(text)

        doc.close()
        os.remove(tmp_file.name)

    # Decision: send full or sample
    if total_chars <= DIRECT_SEND_LIMIT:
        return "\n\n".join(all_pages)
    else:
        logger.info(f"Document exceeds {DIRECT_SEND_LIMIT} chars ({total_chars}), applying sampling")
        return sample_large_document(all_pages)


def sample_large_document(pages: list, target_chars: int = 160000) -> str:
    """
    For documents exceeding the direct send limit, sample:
    - First 20% of pages (introduction, context setting)
    - Evenly spaced pages from the middle 60%
    - Last 10% of pages (conclusions, summaries)

    Total output stays within target_chars.
    """
    total_pages = len(pages)

    # Always include first 20% and last 10%
    first_count = max(2, total_pages // 5)
    last_count = max(2, total_pages // 10)

    first_section = pages[:first_count]
    last_section = pages[-last_count:]

    # Budget remaining chars for middle sampling
    first_chars = sum(len(p) for p in first_section)
    last_chars = sum(len(p) for p in last_section)
    middle_budget = target_chars - first_chars - last_chars

    # Sample from middle pages
    middle_start = first_count
    middle_end = total_pages - last_count
    middle_pages = pages[middle_start:middle_end]

    sampled_middle = []
    middle_chars = 0
    step = max(1, len(middle_pages) // 8)  # pick ~8 evenly spaced pages
    for i in range(0, len(middle_pages), step):
        if middle_chars + len(middle_pages[i]) > middle_budget:
            break
        sampled_middle.append(middle_pages[i])
        middle_chars += len(middle_pages[i])

    # Combine with separator indicating sampling
    result_parts = (
        first_section
        + ["--- [sampled middle pages] ---"]
        + sampled_middle
        + ["--- [final pages] ---"]
        + last_section
    )
    return "\n\n".join(result_parts)
```

### New Helper: `call_haiku_for_topics()`

Sends the extracted text to Claude 3 Haiku with retry logic and response cleaning.

```python
# NOTE: Hard-coded to Haiku for cost/speed. If extraction quality is insufficient,
# consider switching to Claude 3 Sonnet (anthropic.claude-3-sonnet-20240229-v1:0).
# The model ID can be made configurable via SSM parameter in a future iteration.
TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

def call_haiku_for_topics(full_text: str) -> dict:
    """
    Call Claude 3 Haiku to extract main topics from document text.
    Returns a dict with topics, learning_objectives, and provenance metadata.
    Retries up to 3 times on JSON parse failures.
    """
    prompt = """Analyze this educational document and extract the core subject matter.

Identify only the concepts that an instructor would expect students to learn
and be assessed on.

Exclude:
- Examples and case studies
- Citations and references
- Supporting details and tangential mentions
- Administrative content (syllabus info, grading policies)
- Appendices and indexes

Prefer broad conceptual topics over narrow subtopics.

Return ONLY a valid JSON object (no markdown, no explanation):
{
    "topics": ["topic1", "topic2", ...],
    "learning_objectives": ["objective1", "objective2", ...]
}

Limit: maximum 5 topics and 5 learning objectives.

Document text:
"""

    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": prompt + full_text}
        ]
    })

    for attempt in range(3):
        try:
            response = bedrock_runtime.invoke_model(
                modelId=TOPIC_EXTRACTION_MODEL_ID,
                body=request_body
            )
            result = json.loads(response["body"].read())
            content = result["content"][0]["text"]

            # Clean response: strip markdown fences if present
            content = content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1]  # remove opening fence
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            parsed = json.loads(content)

            # Validate structure
            if "topics" not in parsed or not isinstance(parsed["topics"], list):
                raise ValueError("Missing or invalid 'topics' field")

            # Add provenance metadata
            parsed["extracted_at"] = datetime.now(timezone.utc).isoformat()
            parsed["model"] = TOPIC_EXTRACTION_MODEL_ID
            parsed["version"] = 1

            return parsed

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning(f"Topic extraction attempt {attempt + 1} failed: {e}")
            if attempt == 2:
                raise

    raise RuntimeError("Topic extraction failed after 3 attempts")
```

### New Helper: `update_file_metadata()`

Stores the extracted topics in the Module_Files metadata column (JSONB), nested under a `topic_extraction` key. Uses `file_id` as the identifier.

```python
def update_file_metadata(file_id: str, topics: dict, s3_etag: str):
    """
    Update the metadata column of Module_Files with extracted topics.
    Uses file_id as identifier. Nests under 'topic_extraction' key.
    Stores ETag for idempotency checks.
    """
    connection = connect_to_db()
    cur = connection.cursor()

    # Read existing metadata to merge (don't overwrite other fields)
    cur.execute("""
        SELECT metadata FROM "Module_Files"
        WHERE file_id = %s;
    """, (file_id,))
    row = cur.fetchone()

    existing = {}
    if row and row[0]:
        existing = row[0] if isinstance(row[0], dict) else json.loads(row[0])

    # Store topics with ETag for idempotency
    topics["s3_etag"] = s3_etag
    existing["topic_extraction"] = topics

    cur.execute("""
        UPDATE "Module_Files"
        SET metadata = %s::jsonb
        WHERE file_id = %s;
    """, (json.dumps(existing), file_id))
    connection.commit()
    cur.close()
```

### Idempotency Check (ETag-based)

Skip re-extraction if the file content hasn't changed (same S3 ETag):

```python
def should_extract_topics(file_id: str, s3_etag: str) -> bool:
    """
    Check if topic extraction is needed by comparing S3 ETag.
    If the ETag matches what was previously extracted, content hasn't changed.
    """
    connection = connect_to_db()
    cur = connection.cursor()
    cur.execute("""
        SELECT metadata FROM "Module_Files"
        WHERE file_id = %s;
    """, (file_id,))
    row = cur.fetchone()
    cur.close()

    if not row or not row[0]:
        return True

    meta = row[0] if isinstance(row[0], dict) else json.loads(row[0])
    topic_data = meta.get("topic_extraction")
    if not topic_data:
        return True

    # Compare ETags — if same, content hasn't changed, skip extraction
    stored_etag = topic_data.get("s3_etag")
    if stored_etag and stored_etag == s3_etag:
        logger.info(f"Skipping topic extraction — ETag unchanged ({s3_etag})")
        return False

    return True
```

### Impact on Existing Pipeline

| Component | Change |
|---|---|
| `handler()` in `main.py` | Add topic extraction block between file insert and vectorstore update |
| `process_documents()` | **No changes** |
| `store_doc_texts()` | **No changes** |
| `store_doc_chunks()` | **No changes** |
| `update_vectorstore_from_s3()` | **No changes** |
| Lambda timeout (600s) | Topic extraction adds ~5-15s. Acceptable within budget. |
| IAM permissions | Already has `bedrockPolicyStatement` (Haiku model included) |

### Failure Scenarios

| Failure | Impact |
|---|---|
| Bedrock throttled/timeout | File upload succeeds, vectorstore updated, metadata stays NULL |
| Invalid JSON after 3 retries | Logged, metadata stays NULL |
| PDF text extraction fails | Logged, metadata stays NULL, vectorstore proceeds independently |
| DB metadata update fails | Logged, no impact on upload or vectorstore |

---

## Layer 2: Module-Level Aggregation ("Generate Topics" Button)

### Trigger

Manual only — instructor clicks "Generate Topics" button on the edit/create module page.

### New API Endpoint

```
POST /instructor/generate_topics
Query params: module_id
Response:
  Success: { "topics": [...], "learning_objectives": [...], "source_file_ids": [...], "source_file_count": N }
  Partial: { "status": "processing", "ready": 3, "total": 5 }
```

### Staleness Detection

The generated topics store the `source_file_ids` that were used. The frontend compares this against the current file list to detect staleness:

```python
# Staleness check (frontend or backend):
current_file_ids = set(get_module_file_ids(module_id))
source_file_ids = set(generated_topics.get("source_file_ids", []))

is_stale = current_file_ids != source_file_ids
```

This detects:
- New files added (file_id in current but not in source)
- Files deleted (file_id in source but not in current)
- No need to manually clear `generated_topics` on upload/delete

### Backend Logic

```python
def generate_module_topics(module_id: str) -> dict:
    """
    Aggregate per-file topics into module-level consolidated topics.
    Returns consolidated result or processing status.
    """
    connection = connect_to_db()
    cur = connection.cursor()

    # 1. Get all files and their metadata for this module
    cur.execute("""
        SELECT file_id, filename, filetype, metadata FROM "Module_Files"
        WHERE module_id = %s;
    """, (module_id,))
    rows = cur.fetchall()
    cur.close()

    if not rows:
        return {"status": "no_files", "topics": [], "learning_objectives": []}

    # 2. Check how many files have topic extraction completed
    total_files = len(rows)
    files_with_topics = 0
    all_topics = []
    all_objectives = []
    source_file_ids = []

    for file_id, filename, filetype, metadata in rows:
        if metadata:
            meta = metadata if isinstance(metadata, dict) else json.loads(metadata)
            topic_data = meta.get("topic_extraction")
            if topic_data and topic_data.get("topics"):
                files_with_topics += 1
                all_topics.extend(topic_data["topics"])
                all_objectives.extend(topic_data.get("learning_objectives", []))
                source_file_ids.append(str(file_id))

    # 3. If not all files are processed, return status
    if files_with_topics < total_files:
        return {
            "status": "processing",
            "ready": files_with_topics,
            "total": total_files
        }

    # 4. If only one file with few topics, skip consolidation LLM call
    if len(all_topics) <= 5 and len(all_objectives) <= 5:
        consolidated = {
            "topics": all_topics,
            "learning_objectives": all_objectives,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "model": "direct-passthrough",
            "source_file_count": files_with_topics,
            "source_file_ids": source_file_ids
        }
    else:
        # 5. Call Haiku to consolidate
        consolidated = call_haiku_for_consolidation(all_topics, all_objectives, files_with_topics)
        consolidated["source_file_ids"] = source_file_ids

    # 6. Store at module level
    cur = connection.cursor()
    cur.execute("""
        UPDATE "Course_Modules"
        SET generated_topics = %s::jsonb
        WHERE module_id = %s;
    """, (json.dumps(consolidated), module_id))
    connection.commit()
    cur.close()

    return consolidated
```

### Consolidation Prompt

```python
def call_haiku_for_consolidation(all_topics: list, all_objectives: list, file_count: int) -> dict:
    """
    Consolidate per-file topics into module-level topics via Claude 3 Haiku.
    """
    topics_list = "\n".join(f"- {t}" for t in all_topics)
    objectives_list = "\n".join(f"- {o}" for o in all_objectives)

    prompt = f"""You are analyzing the combined topics from all course materials in a single module.
Multiple documents have been analyzed individually and their topics extracted.

Here are all the topics found across {file_count} documents:
{topics_list}

Here are all the learning objectives found:
{objectives_list}

Consolidate these into:
- "topics": The overarching main topics (maximum 7). Remove duplicates and merge
  overlapping topics. Only keep topics that represent core subject matter.
- "learning_objectives": The key learning objectives (maximum 7). Merge similar
  objectives and keep only the most important.

Do not set a minimum. If only 1-2 core topics exist, return only those.
Return valid JSON only, no markdown formatting:
{{"topics": [...], "learning_objectives": [...]}}
"""

    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": prompt}
        ]
    })

    for attempt in range(3):
        try:
            response = bedrock_runtime.invoke_model(
                modelId=TOPIC_EXTRACTION_MODEL_ID,
                body=request_body
            )
            result_body = json.loads(response["body"].read())
            content = result_body["content"][0]["text"].strip()

            # Clean markdown fences
            if content.startswith("```"):
                content = content.split("\n", 1)[1]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            parsed = json.loads(content)

            # Add provenance
            parsed["generated_at"] = datetime.now(timezone.utc).isoformat()
            parsed["model"] = TOPIC_EXTRACTION_MODEL_ID
            parsed["source_file_count"] = file_count

            return parsed

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning(f"Consolidation attempt {attempt + 1} failed: {e}")
            if attempt == 2:
                raise

    raise RuntimeError("Topic consolidation failed after 3 attempts")
```

### Cost

- Input: ~200-500 tokens (just topic/objective strings)
- Output: ~200 tokens
- Cost per click: ~$0.0002 (negligible)

### Optimization: Skip consolidation for single-file modules

If total topics ≤5 and objectives ≤5, pass through directly without an LLM call.

---

## Layer 3: System Prompt Injection (text_generation Lambda)

### Injection Logic (Simplified)

No keyword heuristics. Simple rule:

```python
def should_inject_topics(module_prompt: str) -> bool:
    """
    Inject extracted topics only when no module prompt exists.
    If the instructor wrote a module prompt, trust it entirely.
    """
    return not module_prompt or not module_prompt.strip()
```

### Topic Fetching

```python
def get_module_topics(module_id: str, connection) -> str:
    """
    Fetch aggregated module topics from Course_Modules.
    Returns formatted string for prompt injection, or empty string.
    """
    try:
        cur = connection.cursor()
        cur.execute("""
            SELECT generated_topics FROM "Course_Modules"
            WHERE module_id = %s;
        """, (module_id,))
        result = cur.fetchone()
        cur.close()

        if not result or not result[0]:
            return ""

        topics_data = result[0]  # JSONB, already a dict
        topics = topics_data.get("topics", [])
        objectives = topics_data.get("learning_objectives", [])

        if not topics:
            return ""

        section = "Primary concepts covered by this module:\n"
        section += "\n".join(f"- {t}" for t in topics)
        if objectives:
            section += "\n\nKey learning objectives:\n"
            section += "\n".join(f"- {o}" for o in objectives)
        section += "\n\nWhen answering questions, prioritize explanations that relate to these concepts."
        return section

    except Exception as e:
        logger.warning(f"Failed to fetch module topics: {e}")
        return ""
```

### Updated System Prompt Assembly

```python
# In get_response_streaming():
module_topics_section = ""
if should_inject_topics(module_prompt):
    module_topics_section = get_module_topics(module_id, connection)

system_prompt = (
    f"{SYSTEM_LEVEL_PROMPT}\n"
    f"Your job is to help the student understand the concepts in the course reading on topic: {topic}.\n"
    f"{module_topics_section}\n"
    f"{course_system_prompt}\n"
    f"{module_prompt}\n"
    "\nRetrieved Context:\n"
    "{context}"
)
```

---

## Frontend Changes

### "Generate Topics" Button (InstructorEditCourse / InstructorNewModule)

Add a button below the file management section:

```jsx
<Button
    variant="contained"
    color="secondary"
    onClick={handleGenerateTopics}
    disabled={isGeneratingTopics || (files.length === 0 && savedFiles.length === 0)}
>
    {isGeneratingTopics ? "Generating..." : "Generate Topics"}
</Button>
```

### Staleness Indicator

If generated topics exist but are stale (file list has changed), show a warning:

```jsx
{moduleTopics && isTopicsStale && (
    <Typography variant="caption" color="warning.main">
        ⚠ Topics may be outdated — files have been added or removed since last generation.
    </Typography>
)}
```

Staleness detection on frontend:

```jsx
const currentFileIds = files.map(f => f.file_id).sort();
const sourceFileIds = (moduleTopics?.source_file_ids || []).sort();
const isTopicsStale = JSON.stringify(currentFileIds) !== JSON.stringify(sourceFileIds);
```

### Response Handling

```jsx
const handleGenerateTopics = async () => {
    setIsGeneratingTopics(true);
    try {
        const result = await apiClient.post("instructor/generate_topics", {
            module_id: module.module_id,
        });

        if (result.status === "processing") {
            toast.info(
                `Topic extraction is still processing (${result.ready}/${result.total} files ready). Please try again shortly.`
            );
        } else {
            setModuleTopics(result);
            toast.success("Topics generated successfully");
        }
    } catch (error) {
        toast.error("Failed to generate topics");
    } finally {
        setIsGeneratingTopics(false);
    }
};
```

### Topics Display

Show generated topics as reference for the instructor when writing the module prompt:

```jsx
{moduleTopics && moduleTopics.topics && moduleTopics.topics.length > 0 && (
    <Box sx={{ marginTop: 2 }}>
        <Typography variant="subtitle2">Generated Topics (use as reference for module prompt):</Typography>
        <ul>
            {moduleTopics.topics.map((topic, i) => (
                <li key={i}>{topic}</li>
            ))}
        </ul>
        {moduleTopics.learning_objectives && moduleTopics.learning_objectives.length > 0 && (
            <>
                <Typography variant="subtitle2">Learning Objectives:</Typography>
                <ul>
                    {moduleTopics.learning_objectives.map((obj, i) => (
                        <li key={i}>{obj}</li>
                    ))}
                </ul>
            </>
        )}
    </Box>
)}
```

### File Processing Status

Show per-file extraction status when the page loads:

```jsx
{files.map((file) => (
    <Box key={file.fileName} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography>{file.fileName}</Typography>
        {file.hasTopics ? "✓ Topics extracted" : "⏳ Processing..."}
    </Box>
))}
```

---

## Database Schema Changes

### Module_Files.metadata (ALTER column type)

Change from `TEXT` to `JSONB`:

```sql
ALTER TABLE "Module_Files"
ALTER COLUMN metadata TYPE JSONB
USING CASE
    WHEN metadata = '' THEN NULL
    WHEN metadata IS NULL THEN NULL
    ELSE metadata::jsonb
END;
```

Stores per-file data nested under keys for future extensibility:

```json
{
    "topic_extraction": {
        "topics": ["Topic A", "Topic B", "Topic C"],
        "learning_objectives": ["Objective 1", "Objective 2"],
        "extracted_at": "2026-06-06T12:00:00Z",
        "model": "anthropic.claude-3-haiku-20240307-v1:0",
        "version": 1,
        "s3_etag": "abc123def456"
    }
}
```

### Course_Modules.generated_topics (NEW column)

```sql
ALTER TABLE "Course_Modules"
ADD COLUMN generated_topics JSONB DEFAULT NULL;
```

Stores module-level aggregated result with source tracking:

```json
{
    "topics": ["Consolidated Topic 1", "Consolidated Topic 2"],
    "learning_objectives": ["Consolidated Objective 1", "Consolidated Objective 2"],
    "generated_at": "2026-06-06T12:00:00Z",
    "model": "anthropic.claude-3-haiku-20240307-v1:0",
    "source_file_count": 5,
    "source_file_ids": ["uuid-1", "uuid-2", "uuid-3", "uuid-4", "uuid-5"]
}
```

---

## IAM & Infrastructure Changes

| Change | Details |
|---|---|
| Bedrock model access | Haiku already permitted via `bedrockPolicyStatement` in data_ingestion |
| data_ingestion Lambda | Already has Bedrock permissions — no change needed |
| instructorFunction Lambda | Haiku already in `dbLambdaRole` Bedrock policy — no change needed |
| New API endpoint | Add `POST /instructor/generate_topics` to OpenAPI spec |
| DB migration | Alter `Module_Files.metadata` to JSONB; add `generated_topics` to `Course_Modules` |

---

## Cost Estimates

| Action | Frequency | Input Tokens | Output Tokens | Cost |
|---|---|---|---|---|
| Per-file extraction | Each PDF upload | ~5K-40K (capped by sampling) | ~200 | $0.001–$0.01 |
| Module aggregation | Manual button click | ~200-500 | ~200 | ~$0.0002 |

---

## Re-upload Behavior

When a file is re-uploaded (same filename to same module):
- `insert_file_into_db()` already handles upsert (UPDATE if exists)
- ETag-based idempotency: if S3 ETag matches stored ETag, content unchanged → skip
- If ETag differs (new content): topic extraction runs again, overwrites `topic_extraction` metadata
- Module-level `generated_topics` becomes stale (detected via `source_file_ids` comparison)
- Instructor sees staleness indicator and can click "Generate Topics" to refresh

---

## Constraints

- Per-file extraction: max 5 topics per file (enforced by prompt)
- Documents ≤160K chars (~40K tokens): sent in full to Haiku
- Documents >160K chars: sampled (first 20% + middle samples + last 10%) capped at ~40K tokens
- Module aggregation: max 7 topics, no minimum (enforced by prompt)
- Non-blocking: topic extraction failure never blocks the upload or vectorstore pipeline
- Model: Claude 3 Haiku (`anthropic.claude-3-haiku-20240307-v1:0`) hard-coded for both layers
- Retry: up to 3 attempts on JSON parse failures with response cleaning
- Injection rule: topics injected into chatbot prompt ONLY when module_prompt is empty
- Idempotency: ETag-based — skip extraction if file content unchanged
- Metadata nesting: stored under `topic_extraction` key to prevent overwriting future metadata
- Staleness: tracked via `source_file_ids` in generated_topics (no manual clearing needed)
- File identifiers: all metadata operations use `file_id` (not filename)

---

## Future Optimizations (Not Blocking Implementation)

- **Single extraction pass**: Refactor `data_ingestion` to extract PDF text once and share between topic extraction and vectorstore chunking. Currently extracts twice (isolated but redundant ~1-5s). The refactor requires modifying `store_doc_texts()` return values and threading text through 3 layers of helpers — not worth the coupling risk for v1.
- **Configurable model**: Move `TOPIC_EXTRACTION_MODEL_ID` to an SSM parameter or environment variable so the model can be swapped (e.g., to Sonnet for higher quality) without redeploying.
- **Vector store reuse**: Derive topics from already-created chunks instead of re-extracting from PDF.
- **Chunk-based sampling**: For very large documents, sample from semantic chunks (post-vectorstore) instead of raw pages for better topic coverage.
- **Structured output**: Use Bedrock tool_use/structured output instead of prompt-based JSON to eliminate retry/cleaning logic.
- **Instructor editing**: Allow instructors to edit/override generated topics rather than just viewing them.
- **Tokenizer**: Replace character-based threshold with actual token counting (tiktoken) for more precise context window management.
- **Confidence scores**: Add per-topic confidence values if extraction quality needs to be surfaced to instructors.
