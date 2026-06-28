> **SUPERSEDED — not implemented.** This spec proposed a `ThreadPoolExecutor` refactor of the
> `DataIngestLambdaDockerFunc` container (`topic_aggregation.py`, `aggregate_module_topics`) that
> was never landed. It was superseded by (1) the **topic-extraction** spec's `generateTopics.js`
> endpoint (`POST /instructor/generate_topics`) for module-level topic consolidation, triggered
> from the frontend, and (2) the **multimodal-rag-v2** pipeline, which replaced the monolithic
> data-ingestion container. Retained for historical context only — do not implement.

# Design Document — Topic Extraction Pipeline

## Overview

This feature refactors the data ingestion pipeline to run embeddings indexing (Step 8) and
per-file topic extraction (Step 7) concurrently inside a single Lambda invocation using
`ThreadPoolExecutor(max_workers=2)`, then triggers module-level topic aggregation once every
file in the module has completed extraction. A new `topic_aggregation.py` module encapsulates
the aggregation logic, replicating `cdk/lambda/lib/generateTopics.js` in Python.

All changes are confined to `DataIngestLambdaDockerFunc`. No new Lambda functions, IAM
permissions, or AWS infrastructure are required.

---

## Architecture

### Execution Flow

```
handler(event)
│
├── Steps 1–5 (sequential, unchanged)
│   1. Insert/update Module_Files record
│   2. Download file bytes from S3
│   3. Content-hash deduplication check
│   4. Set processing_status = 'processing'
│   5. Acquire advisory module lock
│
├── Step 6 (sequential prerequisite)
│   process_file_in_memory(file_bytes, ...) → (chunks, full_text)
│   [produces inputs for both concurrent tasks]
│
├── ThreadPoolExecutor(max_workers=2)
│   ├── Future A — embedder_task(chunks, vectorstore, conn, ...)
│   │   └── incremental_index(file_id, chunks, vectorstore, conn, ...)
│   │       → IndexResult(deleted, inserted)
│   │
│   └── Future B — topic_task(full_text, file_id, s3_etag, db_secret, ...)
│       ├── open own psycopg2 connection (thread-safe isolation)
│       ├── should_extract_topics(file_id, s3_etag, conn) → bool
│       ├── [if True and full_text] call_haiku_for_topics(full_text, ...)
│       └── [if success] update_file_metadata(file_id, topics, s3_etag, conn)
│
├── Await both futures (.result())
│   ├── topic exception     → logger.warning + swallow (awaited first)
│   └── embedder exception  → re-raise (existing failure path)
│
├── Step 9 — metadata/status finalization (sequential, unchanged, runs FIRST)
│   ├── update_content_hash(file_id, content_hash, conn)
│   ├── update_chunk_count(file_id, index_result["inserted"], conn)
│   └── update_processing_status(file_id, 'complete', conn)
│       [commits — current file's status is now 'complete']
│
├── Module completion check + aggregation (NEW PLACEMENT: after Step 9, before Step 10)
│   └── if topic future did not re-raise:
│       ├── all_files_have_topics(module_id, conn) → bool
│       │   [current file now observed as 'complete' — see timing note]
│       └── if True: aggregate_module_topics(module_id, conn, bedrock_runtime)
│           [exception swallowed with logger.warning]
│
└── Step 10 — metrics (sequential, always runs)
    └── record_processing_metrics(...)
```

> **Timing note**: The completion check MUST run after Step 9 commits the current
> file's `processing_status = 'complete'`. Because files are serialized by the
> session-level advisory module lock (Step 5), the file that completes a module is
> the last to run. If the completion check ran before Step 9, `all_files_have_topics`
> (which requires `status = 'complete'` for every row) would observe the current file
> as still `'processing'` and return `False`, so aggregation would never fire. Running
> the check after Step 9 guarantees the current file is genuinely `'complete'` when its
> own check executes.

### Thread Safety

`psycopg2` connections are **not thread-safe**. The two concurrent tasks therefore use
isolated connections:

| Thread | Connection source |
|---|---|
| Main / embedder | Existing `conn` (global cached connection via `connect_to_db()`) |
| Topic thread | New `psycopg2.connect()` call using `get_secret()`, opened inside `topic_task` and closed in `finally` |

The topic thread's connection is never exposed to the main thread and is always closed
before the future resolves.

---

## Component Design

### `main.py` Changes

#### New helper: `embedder_task`

```python
def embedder_task(
    file_id: str,
    chunks: list,
    vectorstore,
    connection,
    collection_name: str,
) -> dict:
    """Run incremental_index in a thread. Returns the index result dict."""
    return incremental_index(
        file_id=file_id,
        chunks=chunks,
        vectorstore=vectorstore,
        connection=connection,
        collection_name=collection_name,
    )
```

#### New helper: `topic_task`

```python
def topic_task(
    full_text: str,
    file_id: str,
    s3_etag: str,
    db_secret: dict,
    bedrock_client,
) -> None:
    """
    Run per-file topic extraction in a thread.
    Opens and closes its own psycopg2 connection (thread-safety).
    Raises on failure — the caller in handler() swallows this exception.
    """
    conn = None
    try:
        conn = psycopg2.connect(
            dbname=db_secret["dbname"],
            user=db_secret["username"],
            password=db_secret["password"],
            host=RDS_PROXY_ENDPOINT,
            port=db_secret["port"],
            sslmode="require",
        )
        if not full_text:
            logger.info(
                "Skipping topic extraction — no text extracted",
                extra={"file_id": file_id},
            )
            return
        if should_extract_topics(file_id, s3_etag, conn):
            topics = call_haiku_for_topics(
                full_text, bedrock_client, "full_document", len(full_text)
            )
            update_file_metadata(file_id, topics, s3_etag, conn)
            logger.info(
                "Topic extraction completed",
                extra={"file_id": file_id, "extraction_method": "full_document"},
            )
    finally:
        if conn:
            conn.close()
```

#### Concurrent execution block (replaces Steps 7–8)

```python
# Step 6: Process file in memory — produces chunks AND full_text
chunks, full_text = process_file_in_memory(
    file_bytes=file_bytes,
    file_id=file_id,
    filename=f"{file_name}.{file_type}",
    embeddings=embeddings,
    bucket=bucket_name,
)

# Steps 7+8 concurrently
db_secret = get_secret()
with ThreadPoolExecutor(max_workers=2) as executor:
    embedder_future = executor.submit(
        embedder_task,
        file_id, chunks, vectorstore, conn, module_id,
    )
    topic_future = executor.submit(
        topic_task,
        full_text, file_id, s3_etag, db_secret, bedrock_runtime,
    )

# Await both — order matters for error semantics
topic_exc = None
try:
    topic_future.result()
except Exception as e:
    topic_exc = e
    logger.warning(
        "Topic extraction failed (non-blocking)",
        extra={"file_id": file_id, "error": str(e)},
    )

index_result = embedder_future.result()  # re-raises on embedder failure

# Step 9: metadata/status finalization (runs FIRST, commits 'complete')
update_content_hash(file_id, content_hash, conn)
update_chunk_count(file_id, index_result["inserted"], conn)
update_processing_status(file_id, 'complete', conn)  # commits — file now 'complete'

# Module completion check + aggregation (AFTER Step 9, BEFORE Step 10 metrics)
from topic_aggregation import all_files_have_topics, aggregate_module_topics
if topic_exc is None:  # only check when topic phase did not error
    if all_files_have_topics(module_id, conn):
        try:
            aggregate_module_topics(module_id, conn, bedrock_runtime)
        except Exception as agg_exc:
            logger.warning(
                "Module topic aggregation failed (non-blocking)",
                extra={"module_id": module_id, "error": str(agg_exc)},
            )

# Step 10: metrics — always runs, even if aggregation threw or check was False
record_processing_metrics(...)
```

> **Lock span**: The existing `main.py` wraps Steps 6–10 in a single `try/except`
> with `release_module_lock(module_id, conn)` in the `finally` block. The session-level
> advisory lock (`pg_try_advisory_lock`, acquired at Step 5) is therefore held across
> the Step 9 writes, the completion check, the `aggregate_module_topics` call, and the
> Step 10 metrics recording, and is only released in `finally`. This serializes files
> within a module so the completion check observes a consistent set of committed rows.

> **Note on import placement**: `topic_aggregation` imports are placed at the top of
> `main.py` alongside the existing `topic_extraction` imports in the final implementation.
> The inline import above is for illustration only.

---

### New Module: `data_ingestion/src/topic_aggregation.py`

#### Module-level constants and logger

```python
"""
Topic Aggregation Module

Consolidates per-file topics from all Module_Files in a module into
module-level topics using Claude 3 Haiku via Amazon Bedrock.

Functionally equivalent to cdk/lambda/lib/generateTopics.js.
"""

import json
from datetime import datetime, timezone

import psycopg2
from aws_lambda_powertools import Logger

logger = Logger(service="data-ingestion")

TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

_CONSOLIDATION_PROMPT = """\
You are analyzing the combined topics from all course materials in a single module.
Multiple documents have been analyzed individually and their topics extracted.

Here are all the topics found across {file_count} documents:
{topics_list}

Here are all the learning objectives found:
{objectives_list}

Consolidate these into:
- "topics": The overarching main topics (maximum 7). Remove duplicates and merge \
overlapping topics. Only keep topics that represent core subject matter.
- "learning_objectives": The key learning objectives (maximum 7). Merge similar \
objectives and keep only the most important.

Do not set a minimum. If only 1-2 core topics exist, return only those.
Return valid JSON only, no markdown formatting:
{{"topics": [...], "learning_objectives": [...]}}"""
```

#### `all_files_have_topics`

```python
def all_files_have_topics(module_id: str, connection) -> bool:
    """
    Return True iff every Module_Files row for this module has a non-null,
    non-empty topic_extraction.topics array with at least one element.

    Uses a single JSONB-path query to avoid deserialising metadata in Python.

    Args:
        module_id: UUID of the module to check.
        connection: Active psycopg2 connection (main thread's connection).

    Returns:
        True if all files are complete with topics; False otherwise.
    """
    try:
        with connection.cursor() as cur:
            # A file is "ready" when:
            #   processing_status = 'complete'  AND
            #   metadata->'topic_extraction'->'topics' is a non-empty JSON array
            cur.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (
                        WHERE processing_status = 'complete'
                        AND jsonb_array_length(
                            metadata->'topic_extraction'->'topics'
                        ) > 0
                    ) AS ready
                FROM "Module_Files"
                WHERE module_id = %s
                """,
                (module_id,),
            )
            row = cur.fetchone()
            if not row or row[0] == 0:
                return False
            total, ready = row
            return total == ready
    except Exception as e:
        logger.warning(
            "Module completion check failed",
            extra={"module_id": module_id, "error": str(e)},
        )
        return False
```

#### `aggregate_module_topics`

```python
def aggregate_module_topics(
    module_id: str,
    connection,
    bedrock_client,
) -> dict:
    """
    Collect per-file topics and consolidate into module-level topics.
    Writes the result to Course_Modules.generated_topics.

    Passthrough (no Haiku call) when combined topics <= 5 AND objectives <= 5.
    Calls Haiku with retry logic when the combined count exceeds the threshold.

    Args:
        module_id: UUID of the module.
        connection: Active psycopg2 connection.
        bedrock_client: Boto3 Bedrock Runtime client.

    Returns:
        The consolidated dict written to Course_Modules.generated_topics.

    Raises:
        RuntimeError: If the Haiku consolidation call fails after 3 attempts.
    """
    # 1. Collect per-file topic data
    with connection.cursor() as cur:
        cur.execute(
            """
            SELECT file_id, metadata
            FROM "Module_Files"
            WHERE module_id = %s
            """,
            (module_id,),
        )
        rows = cur.fetchall()

    all_topics: list[str] = []
    all_objectives: list[str] = []
    source_file_ids: list[str] = []
    source_file_etags: dict[str, str] = {}

    for file_id, metadata in rows:
        if not metadata:
            continue
        meta = metadata if isinstance(metadata, dict) else json.loads(metadata)
        extraction = meta.get("topic_extraction", {})
        topics = extraction.get("topics") or []
        objectives = extraction.get("learning_objectives") or []
        if topics:
            all_topics.extend(topics)
            all_objectives.extend(objectives)
            source_file_ids.append(str(file_id))
            if extraction.get("s3_etag"):
                source_file_etags[str(file_id)] = extraction["s3_etag"]

    source_file_count = len(source_file_ids)
    now_iso = datetime.now(timezone.utc).isoformat()

    # 2. Passthrough vs. Haiku routing
    if len(all_topics) <= 5 and len(all_objectives) <= 5:
        consolidated = {
            "topics": all_topics,
            "learning_objectives": all_objectives,
            "raw_topics": all_topics,
            "raw_learning_objectives": all_objectives,
            "generated_at": now_iso,
            "model": "direct-passthrough",
            "source_file_count": source_file_count,
            "source_file_ids": source_file_ids,
            "source_file_etags": source_file_etags,
        }
    else:
        llm_result = _call_haiku_for_consolidation(
            all_topics, all_objectives, source_file_count, bedrock_client
        )
        consolidated = {
            "topics": llm_result["topics"],
            "learning_objectives": llm_result.get("learning_objectives", []),
            "raw_topics": all_topics,
            "raw_learning_objectives": all_objectives,
            "generated_at": now_iso,
            "model": TOPIC_EXTRACTION_MODEL_ID,
            "source_file_count": source_file_count,
            "source_file_ids": source_file_ids,
            "source_file_etags": source_file_etags,
        }

    # 3. Write to Course_Modules.generated_topics
    with connection.cursor() as cur:
        cur.execute(
            """
            UPDATE "Course_Modules"
            SET generated_topics = %s::jsonb
            WHERE module_id = %s
            """,
            (json.dumps(consolidated), module_id),
        )
    connection.commit()

    logger.info(
        "Module topic aggregation complete",
        extra={
            "module_id": module_id,
            "source_file_count": source_file_count,
            "model": consolidated["model"],
        },
    )
    return consolidated
```

#### `_call_haiku_for_consolidation` (private)

```python
def _call_haiku_for_consolidation(
    all_topics: list[str],
    all_objectives: list[str],
    file_count: int,
    bedrock_client,
) -> dict:
    """
    Call Claude 3 Haiku to consolidate topics. Retries up to 3 times
    on JSONDecodeError, ValueError, or KeyError.

    Raises:
        RuntimeError: After 3 failed attempts.
    """
    topics_list = "\n".join(f"- {t}" for t in all_topics)
    objectives_list = "\n".join(f"- {o}" for o in all_objectives)
    prompt = _CONSOLIDATION_PROMPT.format(
        file_count=file_count,
        topics_list=topics_list,
        objectives_list=objectives_list,
    )

    request_body = json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [{"role": "user", "content": prompt}],
    })

    last_exc = None
    for attempt in range(3):
        try:
            response = bedrock_client.invoke_model(
                modelId=TOPIC_EXTRACTION_MODEL_ID,
                body=request_body,
            )
            result = json.loads(response["body"].read())
            content = result["content"][0]["text"].strip()

            # Strip markdown fences (same logic as call_haiku_for_topics)
            if content.startswith("```"):
                content = content.split("\n", 1)[1] if "\n" in content else content[3:]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            parsed = json.loads(content)

            if "topics" not in parsed or not isinstance(parsed["topics"], list):
                raise ValueError("Missing or invalid 'topics' field")

            parsed["topics"] = parsed["topics"][:7]
            if isinstance(parsed.get("learning_objectives"), list):
                parsed["learning_objectives"] = parsed["learning_objectives"][:7]
            else:
                parsed["learning_objectives"] = []

            return parsed

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            last_exc = e
            logger.warning(
                f"Consolidation attempt {attempt + 1}/3 failed",
                extra={"error": str(e)},
            )

    raise RuntimeError(
        f"Topic consolidation failed after 3 attempts: {last_exc}"
    )
```

---

## Data Models

### `Module_Files.metadata` — `topic_extraction` entry

Written by `update_file_metadata` in `topic_extraction.py` (unchanged schema):

```json
{
  "topic_extraction": {
    "topics": ["topic1", "topic2"],
    "learning_objectives": ["obj1", "obj2"],
    "confidence": 0.9,
    "coverage": 1.0,
    "extracted_at": "2025-01-01T00:00:00+00:00",
    "model": "anthropic.claude-3-haiku-20240307-v1:0",
    "version": 2,
    "extraction_method": "full_document",
    "s3_etag": "\"abc123\""
  }
}
```

### `Course_Modules.generated_topics` — written by `aggregate_module_topics`

```json
{
  "topics": ["Topic A", "Topic B"],
  "learning_objectives": ["Objective 1"],
  "raw_topics": ["Topic A", "Topic A (dup)", "Topic B"],
  "raw_learning_objectives": ["Objective 1", "Objective 1 (dup)"],
  "generated_at": "2025-01-01T00:00:00+00:00",
  "model": "anthropic.claude-3-haiku-20240307-v1:0",
  "source_file_count": 3,
  "source_file_ids": ["uuid1", "uuid2", "uuid3"],
  "source_file_etags": {
    "uuid1": "\"etag1\"",
    "uuid2": "\"etag2\"",
    "uuid3": "\"etag3\""
  }
}
```

For the passthrough path, `model` is `"direct-passthrough"` and `topics` == `raw_topics`.

---

## Error Handling Matrix

| Failure scenario | Behaviour | Step 9 + Step 10 run? |
|---|---|---|
| Embedder future raises | Re-raised after both futures awaited (topic awaited first, then embedder) | No — enters existing failure path (status `'failed'`, metrics, lock release) |
| Topic future raises | `logger.warning` + swallowed; completion check skipped (`topic_exc` set) | Yes — Step 9 finalizes status, Step 10 records metrics |
| `all_files_have_topics` raises DB exception | Returns `False`; aggregation skipped | Yes — runs after Step 9, so Step 9 already committed; Step 10 still runs |
| `aggregate_module_topics` raises | `logger.warning` + swallowed in handler; runs after Step 9 commit | Yes — Step 9 already committed `'complete'`; Step 10 still runs |
| Haiku call fails all 3 retries | `RuntimeError` propagates to `aggregate_module_topics` caller | Yes (swallowed there); Step 9 already committed, Step 10 still runs |

Because the completion check and aggregation now run **after** Step 9, Step 9's
`processing_status = 'complete'` write is always committed before aggregation is
attempted. No aggregation outcome (skip, success, or exception) can prevent Step 9 from
having run or block Step 10 metrics recording.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions
of a system — essentially, a formal statement about what the system should do. Properties serve
as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Both futures complete before Step 9 finalization

*For any* valid file event, both the embedder future and the topic future resolve (via
`.result()`) before any Step 9 metadata/status finalization write (`update_content_hash`,
`update_chunk_count`, `update_processing_status`) is executed.

**Validates: Requirements 1.1**

---

### Property 2: Embedder exception always propagates

*For any* exception type raised inside the embedder future, the handler re-raises that
exception, triggering the existing failure path (status `'failed'`, metrics, lock release).

**Validates: Requirements 1.3**

---

### Property 3: Topic exception is non-blocking

*For any* exception type raised inside the topic future, the handler logs at `WARNING`
level with `file_id` and `error` fields and does NOT re-raise; Step 9 metadata/status
finalization still executes (setting the final file status to `'complete'`) and Step 10
metrics recording still runs.

**Validates: Requirements 1.4, 6.1, 6.2**

---

### Property 4: ETag-unchanged files never overwrite existing metadata

*For any* file where `should_extract_topics` returns `False` (ETag unchanged),
`call_haiku_for_topics` is never invoked and `update_file_metadata` is never called,
leaving the existing `topic_extraction` entry in `Module_Files.metadata` untouched.

**Validates: Requirements 2.2**

---

### Property 5: Module completion check is correct for all file configurations

*For any* collection of `Module_Files` rows belonging to a module, `all_files_have_topics`
returns `True` if and only if every row has `processing_status = 'complete'` AND a
`metadata->'topic_extraction'->'topics'` array with at least one element; it returns `False`
if any row has a null, empty, or absent topics array, or a non-complete status.

**Validates: Requirements 3.2, 3.3**

---

### Property 6: Topic flattening is exact

*For any* list of `Module_Files` metadata records with `topic_extraction` data,
`aggregate_module_topics` produces flat `raw_topics` and `raw_learning_objectives` lists
that are exactly equal (element-wise) to the concatenation of each file's `topics` and
`learning_objectives` arrays in row order.

**Validates: Requirements 4.2**

---

### Property 7: Passthrough vs. Haiku routing is determined by combined count

*For any* per-file topic data where the total combined topics count is ≤ 5 **and** the
total combined objectives count is ≤ 5, `aggregate_module_topics` writes a document with
`model = "direct-passthrough"` without invoking `bedrock_client.invoke_model`.
*For any* per-file topic data where the total combined topics count is > 5 **or** the
total combined objectives count is > 5, `aggregate_module_topics` invokes
`bedrock_client.invoke_model` exactly once (per non-retried attempt).

**Validates: Requirements 4.3, 4.4**

---

### Property 8: Aggregation output document contains all required fields

*For any* aggregation run (passthrough or Haiku path), the dict returned by
`aggregate_module_topics` and written to `Course_Modules.generated_topics` contains exactly
the fields: `topics` (list), `learning_objectives` (list), `raw_topics` (list),
`raw_learning_objectives` (list), `generated_at` (ISO-8601 string), `model` (string),
`source_file_count` (int), `source_file_ids` (list of strings),
`source_file_etags` (dict).

**Validates: Requirements 4.5**

---

### Property 9: Consolidation retries on the three retryable exception types

*For any* of `json.JSONDecodeError`, `ValueError`, or `KeyError` raised consistently by
the `invoke_model` call, `_call_haiku_for_consolidation` invokes `invoke_model` exactly 3
times and then raises a `RuntimeError` whose message includes the attempt count and the
last exception message.

**Validates: Requirements 5.1, 5.4**

---

### Property 10: Markdown fence stripping is transparent

*For any* valid JSON string `s`, wrapping it in a markdown code fence
(`` ```json\n{s}\n``` `` or `` ```\n{s}\n``` ``) and passing it through the fence-stripping
logic produces a string that is JSON-parseable and structurally equivalent to `s`.

**Validates: Requirements 5.2**

---

### Property 11: Aggregation failure never blocks file completion

*For any* exception type raised by `aggregate_module_topics`, the handler in `main.py`
logs at `WARNING` level with `module_id` and `error` fields, does not re-raise, and
proceeds to execute Step 10 metrics recording. Because aggregation runs only after Step 9
finalization has already committed the file's `processing_status = 'complete'`, the file's
completed status is unaffected by the aggregation failure.

**Validates: Requirements 6.1, 6.2**

---

### Property 12: Completion check observes the current file as committed-complete

*For any* scenario in which the current file is the last file to finish a module (all other
files in the module already `'complete'` with non-empty topics), the completion check runs
only after the current file's Step 9 `update_processing_status(file_id, 'complete', conn)`
has committed; therefore `all_files_have_topics(module_id, conn)` observes the current file
as `'complete'` and returns `True`, triggering aggregation. Equivalently, the completion
check is never invoked while the current file's status is still `'processing'`.

**Validates: Requirements 3.1, 6.3**
