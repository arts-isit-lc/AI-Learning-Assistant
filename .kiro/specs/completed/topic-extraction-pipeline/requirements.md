> **SUPERSEDED — not implemented.** This spec proposed a `ThreadPoolExecutor` refactor of the
> `DataIngestLambdaDockerFunc` container (`topic_aggregation.py`, `aggregate_module_topics`) that
> was never landed. It was superseded by (1) the **topic-extraction** spec's `generateTopics.js`
> endpoint (`POST /instructor/generate_topics`) for module-level topic consolidation, triggered
> from the frontend, and (2) the **multimodal-rag-v2** pipeline, which replaced the monolithic
> data-ingestion container. Retained for historical context only — do not implement.

# Requirements Document

## Introduction

This feature refactors the data ingestion pipeline to execute embeddings indexing and per-file topic extraction concurrently using Python `ThreadPoolExecutor`, replacing the current sequential execution. After each file's topics are written to `Module_Files.metadata`, the Pipeline checks whether every file in the module has completed topic extraction. If the module is complete, the Pipeline runs a Haiku consolidation call and writes the result to `Course_Modules.generated_topics`. All changes are confined to the `DataIngestLambdaDockerFunc` container; no new Lambda functions, IAM permissions, or AWS services are required.

## Glossary

- **Pipeline**: The `DataIngestLambdaDockerFunc` container Lambda, entry point `data_ingestion/src/main.py`.
- **Embedder**: The existing embedding and vectorstore indexing path (Steps 6 and 8 in `main.py` — `process_file_in_memory` followed by `incremental_index`).
- **TopicExtractor**: The existing per-file topic extraction module (`data_ingestion/src/topic_extraction.py`), which calls Claude 3 Haiku and writes results to `Module_Files.metadata`.
- **TopicAggregator**: The new Python module to be created at `data_ingestion/src/topic_aggregation.py`, replicating the logic of `cdk/lambda/lib/generateTopics.js` in Python.
- **Module_Files**: The PostgreSQL table storing per-file records. The `metadata` column (JSONB) holds per-file topic extraction results under the `topic_extraction` key.
- **Course_Modules**: The PostgreSQL table storing module records. The `generated_topics` column (JSONB) holds the consolidated module-level topic result.
- **ThreadPoolExecutor**: Python standard-library concurrent executor used for thread-level parallelism within a single Lambda invocation.
- **Passthrough**: A code path in the TopicAggregator that writes consolidated topics directly from the raw per-file data without invoking Haiku, used when the combined topic count does not exceed the deduplication threshold.
- **Haiku**: Claude 3 Haiku (`anthropic.claude-3-haiku-20240307-v1:0`) accessed via Amazon Bedrock `bedrock-runtime`, used for both per-file extraction and module-level consolidation.

---

## Requirements

### Requirement 1 — Parallel Per-File Processing

**User Story:** As a platform operator, I want embeddings indexing and topic extraction to run concurrently per file, so that overall data ingestion time is reduced without requiring additional Lambda functions.

#### Acceptance Criteria

1. WHEN the Pipeline processes a new or updated file upload event, THE Pipeline SHALL submit the Embedder task and the TopicExtractor task to a `ThreadPoolExecutor` with `max_workers=2` and call `.result()` on both futures before proceeding to Step 9 (metadata finalization).

2. WHEN both futures are submitted, THE Pipeline SHALL pass `full_text` (already extracted by `process_file_in_memory`) to the TopicExtractor thread, eliminating any redundant file download or text extraction.

3. WHEN the Embedder thread raises an exception, THE Pipeline SHALL re-raise that exception after both futures have been awaited, so that the existing failure-handling path (status `'failed'`, metrics recording, lock release) is triggered as before.

4. WHEN the TopicExtractor thread raises an exception, THE Pipeline SHALL log the failure at WARNING level with `logger.warning` using structured extra fields `{"file_id": file_id, "error": str(e)}` and SHALL continue processing without re-raising, preserving the non-blocking behavior of the current sequential implementation.

5. WHILE both threads are executing, THE Pipeline SHALL hold the advisory module lock (acquired at Step 5) until both futures have resolved and all Step 9 finalization writes are complete.

---

### Requirement 2 — Per-File Topic Write Guarantee

**User Story:** As a platform operator, I want each file's extracted topics to be durably written before the Lambda invocation returns, so that module-level aggregation can reliably read complete per-file data.

#### Acceptance Criteria

1. WHEN the TopicExtractor thread completes successfully, THE TopicExtractor SHALL write the extracted topics to `Module_Files.metadata` under the `topic_extraction` key using the existing `update_file_metadata` function before the thread exits.

2. WHEN `should_extract_topics` returns `False` for a file (ETag unchanged), THE TopicExtractor SHALL skip the Haiku call and SHALL NOT overwrite any existing `topic_extraction` entry in `Module_Files.metadata`.

3. IF `full_text` is empty or `None` for a file, THEN THE TopicExtractor SHALL skip the Haiku call and SHALL NOT write a `topic_extraction` entry, logging at INFO level with `{"file_id": file_id}`.

---

### Requirement 3 — Module Completion Check

**User Story:** As a platform operator, I want the Pipeline to automatically determine whether all files in a module have completed topic extraction after each file is processed, so that module-level aggregation is triggered at the right moment without a polling mechanism.

#### Acceptance Criteria

1. WHEN the current file's Step 9 status update has committed (`processing_status` set to `'complete'`), THE Pipeline SHALL call a completion-check function in the TopicAggregator that queries `Module_Files` for all files where `module_id` matches the current file's module. The completion check SHALL run after Step 9 and before Step 10 metrics recording, so that the current file is genuinely `'complete'` when its own check executes.

2. THE TopicAggregator completion-check function SHALL return `True` only if every row for the module has a non-null, non-empty `metadata->'topic_extraction'->'topics'` array with at least one element.

3. IF any file in the module has `processing_status` other than `'complete'` or has a null or empty `topic_extraction.topics` array, THEN THE TopicAggregator completion-check function SHALL return `False`.

4. IF the completion-check query raises a database exception, THEN THE TopicAggregator completion-check function SHALL log the exception at WARNING level and SHALL return `False`, so that aggregation is deferred rather than attempted with incomplete data.

---

### Requirement 4 — Module-Level Topic Aggregation

**User Story:** As an instructor, I want module-level topics to be automatically consolidated from all uploaded files once all files are processed, so that the module has a coherent topic summary without manual intervention.

#### Acceptance Criteria

1. WHEN the module completion check returns `True`, THE Pipeline SHALL invoke the TopicAggregator `aggregate_module_topics` function, passing the `module_id` and the active database connection.

2. WHEN `aggregate_module_topics` is invoked, THE TopicAggregator SHALL collect all `topic_extraction.topics` arrays and `topic_extraction.learning_objectives` arrays from every `Module_Files` row for the module into combined flat lists.

3. WHEN the combined flat list contains 5 or fewer topics AND 5 or fewer learning objectives, THE TopicAggregator SHALL write the Passthrough result to `Course_Modules.generated_topics` without invoking Haiku, using `model: "direct-passthrough"` in the written JSON.

4. WHEN the combined flat list contains more than 5 topics OR more than 5 learning objectives, THE TopicAggregator SHALL invoke Haiku with the consolidation prompt from `generateTopics.js` and write the consolidated result to `Course_Modules.generated_topics`.

5. THE TopicAggregator SHALL write to `Course_Modules.generated_topics` a JSONB document containing the fields: `topics` (array, max 7), `learning_objectives` (array, max 7), `raw_topics` (unfiltered combined array), `raw_learning_objectives` (unfiltered combined array), `generated_at` (ISO-8601 UTC timestamp), `model` (model ID string or `"direct-passthrough"`), `source_file_count` (integer), `source_file_ids` (array of UUID strings), and `source_file_etags` (object mapping file_id to s3_etag string).

6. WHEN `aggregate_module_topics` completes successfully, THE Pipeline SHALL log at INFO level with structured extra fields `{"module_id": module_id, "source_file_count": n, "model": model_id}`.

---

### Requirement 5 — Aggregation Haiku Call Reliability

**User Story:** As a platform operator, I want the aggregation Haiku call to retry on transient failures and produce a valid result, so that module topics are reliably generated even under brief Bedrock service disruptions.

#### Acceptance Criteria

1. WHEN the TopicAggregator invokes Haiku for consolidation, THE TopicAggregator SHALL retry the Bedrock `invoke_model` call up to 3 times on `json.JSONDecodeError`, `ValueError`, or `KeyError` before raising a `RuntimeError`.

2. WHEN the Haiku response contains markdown code fences, THE TopicAggregator SHALL strip the fences before attempting JSON parsing, using the same stripping logic as `call_haiku_for_topics` in `topic_extraction.py`.

3. WHEN the Haiku response JSON is missing the `topics` array or the array is not a list, THE TopicAggregator SHALL raise `ValueError` and count that attempt as a failure toward the 3-attempt limit.

4. WHEN all 3 Haiku consolidation attempts fail, THE TopicAggregator SHALL raise a `RuntimeError` with a message that includes the attempt count and the last exception message.

---

### Requirement 6 — Aggregation Failure Isolation

**User Story:** As a platform operator, I want aggregation failures to be non-blocking, so that a Haiku consolidation error does not cause the file processing result to be marked as failed.

#### Acceptance Criteria

1. IF `aggregate_module_topics` raises any exception, THEN THE Pipeline SHALL log the exception at WARNING level using `logger.warning` with structured extra fields `{"module_id": module_id, "error": str(e)}` and SHALL NOT re-raise the exception.

2. IF `aggregate_module_topics` raises any exception, THEN THE Pipeline SHALL proceed to execute Step 10 metrics recording for the current file. Step 9 finalization (content hash update, chunk count update, status set to `'complete'`) SHALL have already committed before aggregation is invoked, so an aggregation failure SHALL NOT prevent Step 10 metrics recording.

3. WHEN the module completion check returns `False`, THE Pipeline SHALL NOT invoke `aggregate_module_topics` and SHALL proceed directly to Step 10 metrics recording for the current file, Step 9 finalization having already committed.

---

### Requirement 7 — TopicAggregator Module Structure

**User Story:** As a developer, I want the aggregation logic in a dedicated Python module, so that the Pipeline remains readable and the aggregation logic can be tested independently.

#### Acceptance Criteria

1. THE TopicAggregator SHALL be implemented as a new Python module at `cdk/data_ingestion/src/topic_aggregation.py`, exporting at minimum two functions: `all_files_have_topics(module_id, connection) -> bool` and `aggregate_module_topics(module_id, connection, bedrock_client) -> dict`.

2. THE TopicAggregator SHALL use `from aws_lambda_powertools import Logger` with `logger = Logger(service="data-ingestion")` as the sole logging mechanism, with no use of `print()`, `logging.getLogger()`, or any other logging mechanism.

3. THE TopicAggregator consolidation prompt text SHALL be functionally equivalent to the prompt in `cdk/lambda/lib/generateTopics.js` `callHaikuForConsolidation`, producing the same JSON output shape `{"topics": [...], "learning_objectives": [...]}` with a maximum of 7 items per list.

4. THE TopicAggregator SHALL use the same `TOPIC_EXTRACTION_MODEL_ID` constant value (`"anthropic.claude-3-haiku-20240307-v1:0"`) as `topic_extraction.py`, defined at module level.

---

### Requirement 8 — Schema Compatibility

**User Story:** As a platform operator, I want the feature to work against the existing schema without requiring a new migration, so that deployment does not depend on schema changes.

#### Acceptance Criteria

1. THE Pipeline SHALL read and write `Course_Modules.generated_topics` as a JSONB column. THE Pipeline SHALL NOT perform any `ALTER TABLE` or schema migration for this column, as the column is already added by the existing `initializer.py` migration block.

2. THE Pipeline SHALL read `Module_Files.metadata` as a JSONB column. THE Pipeline SHALL NOT perform any `ALTER TABLE` or schema migration for the `metadata` column, as the column type migration from TEXT to JSONB is already handled by the existing `initializer.py` migration block.

3. WHEN querying `Module_Files.metadata` for topic extraction results, THE Pipeline SHALL use the PostgreSQL JSONB path operator (`metadata->'topic_extraction'->'topics'`) rather than deserializing the entire metadata column in Python, so that the completeness check executes in a single database round trip.
