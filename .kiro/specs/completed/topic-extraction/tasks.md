# Implementation Plan: Topic Extraction Feature

## Overview

This plan implements the Topic Extraction feature across 10 tasks covering database schema, backend extraction logic, API endpoint, system prompt injection, and frontend UI. Tasks are ordered by dependency — later tasks depend on earlier ones being complete.

## Tasks

- [x] 1. Database Schema Migration
  Add idempotent SQL migration to `cdk/lambda/initializer/initializer.js` that alters `Module_Files.metadata` from TEXT to JSONB (converting empty strings and NULLs to SQL NULL) and adds `generated_topics JSONB DEFAULT NULL` column to `Course_Modules`. Update `data_ingestion/src/main.py` to write `None` instead of empty string `""` for new file metadata inserts. Use IF EXISTS / IF NOT EXISTS guards for idempotency.
  **Requirements:** 9.1, 9.2, 9.3, 9.4
  **Files:** `cdk/lambda/initializer/initializer.js`, `cdk/data_ingestion/src/main.py`

- [x] 2. Topic Extractor Module — Core Functions
  Create `cdk/data_ingestion/src/topic_extraction.py` with: `extract_text_from_pdf()` (PyMuPDF + OCR fallback, returns full text or sampled text if >160K chars), `sample_large_document()` (first 20% + ~8 evenly-spaced middle pages + last 10%, budget-enforced), `call_haiku_for_topics()` (Bedrock invoke with extraction prompt, markdown fence stripping, JSON validation, 3-attempt retry, provenance metadata), `update_file_metadata()` (read-merge-write by file_id preserving other keys), `should_extract_topics()` (ETag comparison for idempotency). Use Powertools Logger. Define `TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"` constant with future-configurability note.
  **Requirements:** 1.1, 1.2, 1.3, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4
  **Files:** `cdk/data_ingestion/src/topic_extraction.py` (new)

- [x] 3. Integrate Topic Extraction into Data Ingestion Handler
  Modify `handler()` in `cdk/data_ingestion/src/main.py` to call topic extraction between `get_file_id_from_db()` and `update_vectorstore_from_s3()`. Extract `s3_etag` from `record['s3']['object'].get('eTag', '')`. Wrap in try/except logging warning on failure (non-blocking). Only run for ObjectCreated events. Import from `topic_extraction` module.
  **Requirements:** 1.1, 1.4, 1.5
  **Files:** `cdk/data_ingestion/src/main.py`

- [x] 4. Generate Topics API Endpoint — OpenAPI Specification
  Add `POST /instructor/generate_topics` endpoint to `cdk/OpenAPI_Swagger_Definition.yaml` with CORS options block, instructorAuthorizer security, required `module_id` query parameter, and aws_proxy integration pointing to `instructorFunction`. Follow existing endpoint patterns in the file.
  **Requirements:** 6.1, 6.5
  **Files:** `cdk/OpenAPI_Swagger_Definition.yaml`

- [x] 5. Topic Aggregator — instructorFunction Backend
  Add `generate_topics` route handler to `cdk/lambda/lib/instructorFunction.js`. Query all Module_Files for the module_id retrieving file_id and metadata. Check completion status (all files have topic_extraction.topics). Return processing status if incomplete, no_files if empty. Collect per-file topics/objectives. Passthrough if ≤5 each, otherwise call Bedrock Haiku consolidation (max 7 topics, max 7 objectives, no minimum) with 3-attempt retry. Build source_file_ids and source_file_etags. Store in Course_Modules.generated_topics. Return 400 if module_id missing/invalid. Return error without modifying existing data on consolidation failure.
  **Requirements:** 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4, 6.5, 7.1
  **Files:** `cdk/lambda/lib/instructorFunction.js`

- [x] 6. System Prompt Topic Injection
  Add `should_inject_topics(module_prompt)` and `get_module_topics(module_id, connection)` functions to `cdk/text_generation/src/helpers/chat.py`. `should_inject_topics` returns True if module_prompt is empty/whitespace. `get_module_topics` queries Course_Modules.generated_topics, formats as bulleted list under "Primary concepts covered by this module:" and "Key learning objectives:" headings with operational instruction, caps at 7 each. Integrate into `get_response_streaming()` system prompt assembly. Handle NULL/empty gracefully.
  **Requirements:** 8.1, 8.2, 8.3, 8.4, 8.5
  **Files:** `cdk/text_generation/src/helpers/chat.py`

- [x] 7. Frontend — Generate Topics Button and Display
  Add "Generate Topics" button to `InstructorEditCourse.jsx` and `InstructorNewModule.jsx` below file management section. Disable when no files exist. On click call POST /instructor/generate_topics. Show loading state, disable during request. Handle processing response (toast with ready/total count), success (display topic and objective lists), and error (error toast, re-enable). Fetch existing generated_topics on page load to display previously generated results.
  **Requirements:** 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
  **Files:** `frontend/src/pages/instructor/InstructorEditCourse.jsx`, `frontend/src/pages/instructor/InstructorNewModule.jsx`

- [x] 8. Frontend — Staleness Detection and Warning
  On page load compare current file IDs and ETags against generated_topics.source_file_ids and source_file_etags. Display staleness warning if they differ. Remove warning after successful regeneration. Do not show warning if no generated_topics exist.
  **Requirements:** 7.2, 7.3, 7.4, 7.5
  **Files:** `frontend/src/pages/instructor/InstructorEditCourse.jsx`, `frontend/src/pages/instructor/InstructorNewModule.jsx`

- [x] 9. Frontend — File Processing Status Indicators
  When fetching files on page load, check each file's metadata for topic_extraction.topics presence. Display per-file indicator: "✓ Topics extracted" or "⏳ Processing...". Verify get_all_files endpoint returns metadata or extraction status flag; update instructorFunction if needed.
  **Requirements:** 10.3
  **Files:** `frontend/src/pages/instructor/InstructorEditCourse.jsx`, `cdk/lambda/lib/instructorFunction.js`

- [x] 10. End-to-End Verification
  Verify: PDF upload populates Module_Files.metadata with topic_extraction; same-content re-upload skips extraction (ETag match); modified file re-upload triggers re-extraction; Generate Topics produces consolidated result; staleness warning appears after file changes; student chat injects topics when no module_prompt; student chat omits topics when module_prompt exists. Run `npx tsc --noEmit` and `npm run lint` to confirm no errors.
  **Requirements:** All
  **Files:** N/A (testing only)

## Task Dependency Graph

```json
{
  "waves": [
    [1],
    [2, 4, 6],
    [3, 5],
    [7],
    [8, 9],
    [10]
  ]
}
```

- Wave 1: Database migration (prerequisite for all)
- Wave 2: Topic Extractor module, OpenAPI endpoint, and Prompt Injection (independent of each other)
- Wave 3: Handler integration (depends on 2) and Aggregator backend (depends on 4)
- Wave 4: Frontend button and display (depends on 4, 5)
- Wave 5: Staleness and status indicators (depend on 7)
- Wave 6: End-to-end verification (depends on all)

## Notes

- Tasks 2-3 and 4-5 can be developed in parallel (different Lambda runtimes, no dependency between them)
- Task 6 is independent of Tasks 2-5 and can be developed in parallel
- Frontend tasks (7-9) require backend tasks (4-5) to be deployed first for API availability
- Task 1 (migration) must be deployed before any other task can function in a live environment
- No CDK infrastructure changes are needed (IAM permissions already cover Haiku model access)
