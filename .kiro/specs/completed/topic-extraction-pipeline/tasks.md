> **SUPERSEDED — not implemented.** This spec proposed a `ThreadPoolExecutor` refactor of the
> `DataIngestLambdaDockerFunc` container (`topic_aggregation.py`, `aggregate_module_topics`) that
> was never landed. It was superseded by (1) the **topic-extraction** spec's `generateTopics.js`
> endpoint (`POST /instructor/generate_topics`) for module-level topic consolidation, triggered
> from the frontend, and (2) the **multimodal-rag-v2** pipeline, which replaced the monolithic
> data-ingestion container. Retained for historical context only — do not implement.

# Implementation Plan: Topic Extraction Pipeline

## Overview

Implement concurrent per-file processing in the data ingestion Lambda by introducing a new
`topic_aggregation.py` module and refactoring `main.py` to run embeddings indexing and topic
extraction in parallel via `ThreadPoolExecutor(max_workers=2)`. After each file's topics are
written, the pipeline checks whether all module files are complete and, if so, consolidates
module-level topics into `Course_Modules.generated_topics`. All changes are confined to the
`DataIngestLambdaDockerFunc` Python container — no CDK, IAM, or infrastructure changes needed.

## Tasks

- [x] 1. Create `topic_aggregation.py` — module scaffold and `all_files_have_topics`
  - [x] 1.1 Create `cdk/data_ingestion/src/topic_aggregation.py` with module scaffolding and `all_files_have_topics`
    - Add module docstring and imports: `json`, `datetime/timezone`, `aws_lambda_powertools.Logger`
    - Define `TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"` at module level
    - Define `logger = Logger(service="data-ingestion")` — no `print()`, no `logging.getLogger()`
    - Define `_CONSOLIDATION_PROMPT` template string matching the `callHaikuForConsolidation` prompt in `cdk/lambda/lib/generateTopics.js` (same text, same JSON output shape `{"topics": [...], "learning_objectives": [...]}`, max 7 each)
    - Implement `all_files_have_topics(module_id, connection) -> bool` using a single JSONB-path SQL query (see design §`all_files_have_topics`): counts total vs. `complete` rows with `jsonb_array_length(metadata->'topic_extraction'->'topics') > 0`; returns `False` when total is zero; catches DB exceptions, logs `logger.warning` with `module_id` and `error`, returns `False`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 7.1, 7.2, 7.4_

  - [ ]* 1.2 Write unit tests for `all_files_have_topics` in `tests/test_topic_aggregation.py`
    - Add `hypothesis` to `cdk/data_ingestion/requirements.txt` for property-based testing
    - Load module via `importlib.util.spec_from_file_location` (matching existing test pattern) with `aws_lambda_powertools` mocked
    - **Property 5: Completion check correctness** — use `hypothesis.given` with `st.lists` of file-row dicts to assert `all_files_have_topics` returns `True` iff every mock row is `complete` with a non-empty `topics` array; returns `False` otherwise
    - Test returns `False` when total count is 0
    - Test returns `False` on DB exception, verifies `logger.warning` called (not re-raised)
    - Test JSONB path query is issued in a single cursor `execute` call (no Python-side deserialization loop)
    - _Requirements: 3.2, 3.3, 3.4_

- [x] 2. Complete `topic_aggregation.py` — Haiku call and aggregation
  - [x] 2.1 Implement `_call_haiku_for_consolidation` private function in `topic_aggregation.py`
    - Format the consolidation prompt from `_CONSOLIDATION_PROMPT` using `file_count`, `topics_list` (newline-joined `- {t}`), and `objectives_list`
    - Call `bedrock_client.invoke_model(modelId=TOPIC_EXTRACTION_MODEL_ID, body=request_body)` inside a `for attempt in range(3)` loop
    - Strip markdown fences using the same logic as `call_haiku_for_topics` in `topic_extraction.py` (split on first `\n`, strip trailing ` ``` `)
    - Parse JSON response; raise `ValueError("Missing or invalid 'topics' field")` if `topics` is missing or not a list (counts as a retryable failure)
    - Apply limits: `parsed["topics"] = parsed["topics"][:7]` and `parsed["learning_objectives"] = parsed.get("learning_objectives", [])[:7]`
    - Catch `json.JSONDecodeError`, `ValueError`, `KeyError`; log `logger.warning` with attempt number and error; after attempt 3, raise `RuntimeError(f"Topic consolidation failed after 3 attempts: {last_exc}")`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.3_

  - [ ]* 2.2 Write property tests for `_call_haiku_for_consolidation` in `tests/test_topic_aggregation.py`
    - **Property 9: Retry exhaustion** — mock `invoke_model` to always raise `json.JSONDecodeError`; assert it is called exactly 3 times and a `RuntimeError` is raised with "3 attempts" in the message; repeat for `ValueError` and `KeyError`
    - **Property 9 (partial success)** — mock `invoke_model` to fail twice then succeed; assert the result dict is returned without raising
    - **Property 10: Markdown fence stripping** — use `hypothesis.given(st.text())` on valid JSON strings; wrap them in ` ```json\n...\n``` ` and ` ```\n...\n``` ` fences; assert the fence-stripping logic produces a string that parses to the original value
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 2.3 Implement `aggregate_module_topics` in `topic_aggregation.py`
    - Query `Module_Files` for all `(file_id, metadata)` rows where `module_id = %s`
    - Iterate rows: parse metadata (dict or JSON string), collect `topic_extraction.topics` and `topic_extraction.learning_objectives` into flat lists; build `source_file_ids` (list of str UUIDs) and `source_file_etags` (dict mapping file_id str to s3_etag str)
    - Passthrough path (≤5 combined topics AND ≤5 combined objectives): build `consolidated` with `model = "direct-passthrough"`; no Bedrock call
    - Haiku path (>5 topics OR >5 objectives): call `_call_haiku_for_consolidation(all_topics, all_objectives, source_file_count, bedrock_client)`; build `consolidated` with `model = TOPIC_EXTRACTION_MODEL_ID`
    - Both paths: set `raw_topics`, `raw_learning_objectives`, `generated_at` (ISO-8601 UTC), `source_file_count`, `source_file_ids`, `source_file_etags`
    - Write to `Course_Modules`: `UPDATE "Course_Modules" SET generated_topics = %s::jsonb WHERE module_id = %s` then `connection.commit()`
    - Log `logger.info("Module topic aggregation complete", extra={"module_id": ..., "source_file_count": ..., "model": ...})`
    - Return the consolidated dict
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1_

  - [ ]* 2.4 Write property tests for `aggregate_module_topics` in `tests/test_topic_aggregation.py`
    - **Property 6: Topic flattening is exact** — use `hypothesis.given(st.lists(...))` of per-file metadata dicts; assert `raw_topics` equals `list(chain.from_iterable(f["topics"] for f in files_with_topics))` in row order; same for `raw_learning_objectives`
    - **Property 7: Routing correctness** — assert that for any input where `len(all_topics) <= 5 and len(all_objectives) <= 5`, `bedrock_client.invoke_model` is never called and `model == "direct-passthrough"`; for any input where `len(all_topics) > 5 or len(all_objectives) > 5`, `invoke_model` is called at least once
    - **Property 8: Output document completeness** — assert the returned dict always contains exactly the keys: `topics`, `learning_objectives`, `raw_topics`, `raw_learning_objectives`, `generated_at`, `model`, `source_file_count`, `source_file_ids`, `source_file_etags` on both passthrough and Haiku paths
    - _Requirements: 4.2, 4.3, 4.4, 4.5_

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Refactor `main.py` for concurrent execution
  - [x] 4.1 Add imports and `embedder_task` / `topic_task` helper functions to `main.py`
    - Add `from concurrent.futures import ThreadPoolExecutor` to imports at top of file
    - Add `from topic_aggregation import all_files_have_topics, aggregate_module_topics` alongside the existing `topic_extraction` import block
    - Implement `embedder_task(file_id, chunks, vectorstore, connection, collection_name) -> dict`: calls `incremental_index(file_id=file_id, chunks=chunks, vectorstore=vectorstore, connection=connection, collection_name=collection_name)` and returns its result
    - Implement `topic_task(full_text, file_id, s3_etag, db_secret, bedrock_client) -> None`: opens its own `psycopg2.connect(dbname=..., user=..., password=..., host=RDS_PROXY_ENDPOINT, port=..., sslmode="require")` using `db_secret`; if `not full_text`, logs `logger.info("Skipping topic extraction — no text extracted", extra={"file_id": file_id})` and returns; if `should_extract_topics` returns True, calls `call_haiku_for_topics` then `update_file_metadata`; closes connection in `finally` block
    - _Requirements: 1.1, 1.2, 1.5, 2.1, 2.2, 2.3_

  - [x] 4.2 Replace sequential Steps 7+8 in `handler` with `ThreadPoolExecutor(max_workers=2)` concurrent block
    - Remove the existing sequential Step 7 (topic extraction try/except block) and Step 8 (`incremental_index` call)
    - Insert the concurrent block as designed (see design §"Concurrent execution block"): call `get_secret()`, open `ThreadPoolExecutor(max_workers=2)`, submit `embedder_future` and `topic_future`, close the executor context
    - Await topic first: wrap `topic_future.result()` in try/except; on exception set `topic_exc = e` and call `logger.warning("Topic extraction failed (non-blocking)", extra={"file_id": file_id, "error": str(e)})` (initialize `topic_exc = None` before the try so it is always defined)
    - Await embedder second: `index_result = embedder_future.result()` — this re-raises on embedder failure, preserving the existing failure path
    - Preserve the EXISTING Step 9 writes (`update_content_hash`, `update_chunk_count`, `update_processing_status(file_id, 'complete', conn)`) unchanged — they run immediately after the concurrent block and commit the current file's `'complete'` status; do NOT add the completion check or aggregation here (that is task 4.3)
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1_

  - [x] 4.3 Add module completion check and aggregation trigger AFTER Step 9, BEFORE Step 10 in `handler`
    - Placement: insert this block after the Step 9 `update_processing_status(file_id, 'complete', conn)` write has committed and before the Step 10 `record_processing_metrics(...)` call — NOT immediately after the futures resolve (see design §"Concurrent execution block" and the Timing note)
    - Add an `if topic_exc is None:` guard so the completion check is skipped when the topic phase errored
    - Inside the guard: call `all_files_have_topics(module_id, conn)` and if it returns `True`, call `aggregate_module_topics(module_id, conn, bedrock_runtime)` inside a try/except that calls `logger.warning("Module topic aggregation failed (non-blocking)", extra={"module_id": module_id, "error": str(agg_exc)})` on exception — do not re-raise
    - Step 10 `record_processing_metrics` must ALWAYS run afterward, regardless of whether the guard ran, the completion check returned `False`, or `aggregate_module_topics` raised — because Step 9 has already committed `'complete'`, the aggregation outcome cannot block metrics recording
    - _Requirements: 3.1, 4.1, 6.1, 6.2, 6.3_

  - [ ]* 4.4 Write unit tests for concurrent execution in `tests/test_main_concurrent.py`
    - Load `embedder_task` and `topic_task` via `importlib.util.spec_from_file_location` with heavy deps mocked (`boto3`, `psycopg2`, `langchain_aws`, `langchain_postgres`, `aws_xray_sdk`)
    - **Property 2: Embedder exception propagates** — mock `incremental_index` to raise; assert `embedder_task` re-raises the same exception type
    - **Property 3: Topic exception is non-blocking** — mock `call_haiku_for_topics` to raise inside `topic_task`; assert the exception propagates out of `topic_task` (so the handler's try/except can swallow it) and does not affect `embedder_task`
    - **Property 4: ETag-unchanged skip** — mock `should_extract_topics` to return `False`; assert `call_haiku_for_topics` and `update_file_metadata` are never called
    - **Property 11: Aggregation failure never blocks file completion** — assert aggregation runs AFTER the Step 9 status write: mock the Step 9 functions and `aggregate_module_topics` to record call order, verify `update_processing_status(file_id, 'complete', conn)` is invoked before `all_files_have_topics`/`aggregate_module_topics`; mock `aggregate_module_topics` to raise and assert `logger.warning` is called with `module_id` and `error` fields, the exception is not re-raised, and Step 10 `record_processing_metrics` still runs
    - **Property 12: Completion check observes the current file as committed-complete** — simulate the current file as the last file in its module; assert `all_files_have_topics` is only invoked after `update_processing_status(file_id, 'complete', conn)` has committed (never while the current file's status is still `'processing'`), so the check observes the current file as `'complete'` and returns `True` to trigger aggregation
    - _Requirements: 1.3, 1.4, 2.2, 3.1, 6.1, 6.2, 6.3_

- [x] 5. Final Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Schema compatibility is confirmed: `Course_Modules.generated_topics` (JSONB) is already added by the existing `initializer.py` migration block — no `ALTER TABLE` needed
- `topic_task` must open its own `psycopg2` connection; `psycopg2` connections are not thread-safe and must not be shared across threads
- The `topic_aggregation` module imports must appear at the top of `main.py` alongside the existing `topic_extraction` imports (not inline in the handler)
- `hypothesis` is a dev dependency added to `requirements.txt`; the Docker build will install it but it is only used by test files

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "4.2"] },
    { "id": 3, "tasks": ["2.4", "4.3"] },
    { "id": 4, "tasks": ["4.4"] }
  ]
}
```
