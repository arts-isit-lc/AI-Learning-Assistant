# Implementation Plan: Data Ingestion Optimization

## Overview

Convert the data ingestion pipeline from full-module-rebuild to incremental per-file processing using direct SQL operations. Phase 1 delivers ~95% of the performance improvement (single-file processing instead of reprocessing all module files). Phase 2 adds efficiency gains (in-memory processing, metrics, chunking switch). Phase 3 and Phase 4 add batch optimization and scaling.

Architecture principle: **"PGVector is the source of truth. LangChain is optional convenience."**

## Tasks

- [x] 1. Database schema extension and migration
  - [x] 1.1 Create database migration script for Module_Files table extensions
    - Add `content_hash TEXT` column (nullable, for SHA-256 file content hash)
    - Add `processing_status TEXT DEFAULT 'pending'` column
    - Add `last_processed_at TIMESTAMPTZ` column
    - Add `chunk_count INTEGER` column
    - Write migration SQL in `cdk/lambda/initializer/` following existing migration patterns
    - Ensure migration is idempotent (use `IF NOT EXISTS` or equivalent)
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

- [x] 2. Core incremental indexing engine (Phase 1)
  - [x] 2.1 Implement `incremental_index()` function with direct SQL delete+insert
    - Create new file `cdk/data_ingestion/src/indexing/incremental.py`
    - Implement `DELETE FROM langchain_pg_embedding WHERE cmetadata->>'file_id' = %s AND collection_id = %s`
    - Insert new chunks via `PGVector.add_documents()` (LangChain convenience for insertion only)
    - Wrap DELETE + INSERT in a single database transaction for atomicity
    - Return `IndexResult` with deleted count and inserted count
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 2.2 Implement PostgreSQL advisory lock for concurrent access protection
    - Use `pg_try_advisory_lock(hashtext(module_id))` before starting vectorstore operations
    - Raise exception if lock acquisition fails (triggers Lambda retry)
    - Release lock on transaction commit/rollback
    - _Requirements: 15.3, 15.4_

  - [x] 2.3 Enforce mandatory `file_id` in all chunk metadata
    - Modify `store_doc_chunks()` in `cdk/data_ingestion/src/processing/documents.py`
    - Remove conditional `if file_id:` check — make `file_id` unconditionally required
    - Add validation: raise error if any chunk is produced without `file_id`
    - Include `source`, `doc_id`, `page_numbers`, `chunk_index`, `content_hash` in metadata
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 2.4 Write property test for chunk metadata completeness
    - **Property 1: Chunk Metadata Completeness**
    - For any processed document, every chunk SHALL contain `file_id`, `source`, `doc_id`, `page_numbers`, `chunk_index`, `content_hash`
    - **Validates: Requirements 1.1, 1.3**

  - [ ]* 2.5 Write property test for incremental indexing file isolation
    - **Property 2: Incremental Indexing File Isolation**
    - Processing file F leaves all chunks belonging to other files unchanged
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 2.6 Write property test for transaction atomicity
    - **Property 3: Transaction Atomicity**
    - If DELETE+INSERT fails at any point, vectorstore state is identical to before the operation
    - **Validates: Requirements 2.3, 15.6**

- [x] 3. Content hash deduplication (Phase 1)
  - [x] 3.1 Implement `should_reprocess_file()` content deduplication checker
    - Create dedup logic in `cdk/data_ingestion/src/indexing/deduplication.py`
    - Compute SHA-256 hash of file content after S3 download
    - Query `Module_Files.content_hash` to compare with stored value
    - Return False (skip processing) if hashes match
    - Update stored hash after successful processing
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 3.2 Write property test for content hash deduplication
    - **Property 4: Content Hash Deduplication**
    - When hash matches → zero vectorstore writes; when hash differs → vectorstore writes + hash updated
    - **Validates: Requirements 3.1, 3.2, 3.3**

- [x] 4. File deletion handler (Phase 1)
  - [x] 4.1 Implement `handle_file_deletion()` for S3 ObjectRemoved events
    - Add deletion logic in `cdk/data_ingestion/src/indexing/incremental.py`
    - Resolve `file_id` from Module_Files using module_id + filename + filetype
    - Execute `DELETE FROM langchain_pg_embedding WHERE cmetadata->>'file_id' = %s`
    - Update `processing_status` to `'deleted'` in Module_Files
    - Log a warning and skip gracefully if `file_id` cannot be resolved
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 4.2 Write property test for deletion completeness
    - **Property 5: Deletion Completeness**
    - After deletion, zero chunks with that `file_id` exist in vectorstore, and `processing_status = 'deleted'`
    - **Validates: Requirements 4.2, 4.3**

- [ ] 5. Refactor main handler to use incremental pipeline (Phase 1)
  - [x] 5.1 Refactor `handler()` in `cdk/data_ingestion/src/main.py` for incremental flow
    - Remove call to `update_vectorstore_from_s3()` (which triggers full rebuild)
    - Integrate content hash check before processing
    - Add advisory lock acquisition before vectorstore operations
    - Set `processing_status = 'processing'` before vectorstore operations
    - Call `incremental_index()` instead of `index()` with `cleanup="full"`
    - Set `processing_status = 'complete'` on success, `'failed'` on failure
    - Handle ObjectRemoved events by calling `handle_file_deletion()`
    - Update `last_processed_at` and `chunk_count` on success
    - _Requirements: 2.4, 2.5, 3.2, 3.3, 4.1, 16.1, 16.2, 16.3, 16.4_

  - [x] 5.2 Remove SQLRecordManager and `cleanup="full"` usage
    - Remove `langchain-classic` import from `cdk/data_ingestion/src/helpers/helper.py`
    - Remove `record_manager` instantiation and `create_schema()` call
    - Remove `index()` call in `cdk/data_ingestion/src/processing/documents.py`
    - Remove `langchain-classic` from `cdk/data_ingestion/requirements.txt`
    - _Requirements: 2.4_

  - [ ]* 5.3 Write unit tests for the refactored handler
    - Test ObjectCreated flow: content hash check → incremental index → status complete
    - Test ObjectRemoved flow: resolve file_id → delete vectors → status deleted
    - Test content hash match → skip processing entirely
    - Test advisory lock failure → exception raised
    - _Requirements: 2.1, 3.2, 4.1, 15.3, 16.1, 16.2, 16.3_

- [x] 6. Checkpoint — Ensure Phase 1 core logic works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Chunking strategy benchmarking (Phase 1)
  - [x] 7.1 Create benchmark script comparing SemanticChunker vs RecursiveCharacterTextSplitter
    - Create `cdk/data_ingestion/benchmarks/chunking_benchmark.py`
    - Measure retrieval precision and recall on representative query set
    - Record Bedrock API call count and estimated cost per document for each strategy
    - Record chunk size distribution and count for each strategy
    - Output results in structured format for decision-making
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 8. In-memory document processing (Phase 2)
  - [x] 8.1 Implement `process_file_in_memory()` replacing intermediate S3 storage
    - Create `cdk/data_ingestion/src/processing/in_memory.py`
    - Download file from S3 exactly once
    - Extract all page text in memory (PyMuPDF + OCR fallback) without uploading to S3
    - Concatenate pages with boundary markers for cross-page aware chunking
    - Return both chunks (for embedding) and full text (for topic extraction reuse)
    - Implement streaming fallback for memory limit scenarios (process pages sequentially)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 15.1_

  - [ ]* 8.2 Write property test for cross-page chunking awareness
    - **Property 6: Cross-Page Chunking Awareness**
    - Chunking operates on full concatenated text rather than per-page isolation
    - **Validates: Requirement 6.3**

  - [x] 8.3 Wire in-memory processor into the main handler
    - Replace `store_doc_texts()` + `store_doc_chunks()` with `process_file_in_memory()`
    - Reuse extracted text for topic extraction (eliminate second S3 download)
    - Remove embedding bucket S3 read/write operations for page text files
    - _Requirements: 6.1, 6.4_

- [x] 9. Processing metrics and status tracking (Phase 2)
  - [x] 9.1 Implement `ProcessingMetrics` dataclass and `record_processing_metrics()` function
    - Create `cdk/data_ingestion/src/metrics/recorder.py`
    - Define `ProcessingMetrics` with `processing_duration_ms`, `chunk_count`, `embedding_count`, `last_error`, `retry_count`
    - Store metrics in `Module_Files.metadata` JSONB under `processing_metrics` key
    - Update `processing_status` column as state machine transitions
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 9.2 Write property test for processing state machine validity
    - **Property 7: Processing State Machine Validity**
    - Status transitions only through valid states; metric fields present after success/failure
    - **Validates: Requirements 7.1, 7.2, 7.3, 16.1, 16.2, 16.3, 16.4**

- [x] 10. Chunking strategy switch (Phase 2)
  - [x] 10.1 Implement configurable chunking strategy based on benchmark results
    - Add chunking strategy selection (SemanticChunker or RecursiveCharacterTextSplitter)
    - Configure `chunk_size` and `chunk_overlap` parameters for RecursiveCharacterTextSplitter
    - Ensure RecursiveCharacterTextSplitter generates zero Bedrock calls for chunking decisions
    - Only enable switch if benchmark data supports it
    - _Requirements: 8.1, 8.2_

- [x] 11. CDK configuration updates (Phase 1-2)
  - [x] 11.1 Update Lambda configuration in CDK stack
    - Increase timeout from 600s to 900s in `cdk/lib/api-gateway-stack.ts`
    - Increase memory from 512 MB to 1024 MB
    - Remove embedding bucket S3 write permissions (no longer needed after Phase 2)
    - Keep S3 read permission on data ingestion bucket
    - _Requirements: 10.1_

- [x] 12. Checkpoint — Ensure Phase 1 and Phase 2 are complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Batch embedding optimization (Phase 3)
  - [~] 13.1 Implement `batch_embed_chunks()` with batched Bedrock API calls
    - Create `cdk/data_ingestion/src/embedding/batch.py`
    - Group chunks into batches of up to 20 texts per API call
    - Implement exponential backoff with jitter for ThrottlingException (initial 1s, max 30s, 5 retries)
    - Return exactly N embedding vectors for N input chunks in same order
    - Wire into incremental indexing pipeline
    - _Requirements: 9.1, 9.2, 9.3, 15.2_

  - [ ]* 13.2 Write property test for batch embedding correctness
    - **Property 8: Batch Embedding Correctness**
    - For N input chunks, output contains exactly N vectors in same order; API calls = ceil(N/batch_size)
    - **Validates: Requirements 9.1, 9.3**

- [ ] 14. SQS FIFO queue and scaling (Phase 4)
  - [~] 14.1 Add SQS FIFO queue and DLQ to CDK stack
    - Create FIFO queue with ContentBasedDeduplication enabled
    - Configure VisibilityTimeout=720s, MessageRetentionPeriod=86400s
    - Create DLQ with MaxReceiveCount=3
    - Change Lambda event source from S3 direct → SQS
    - Configure S3 notifications to target SQS instead of Lambda
    - Add MessageGroupId pattern `{course_id}/{module_id}` for per-module serialization
    - Add reserved concurrency to Lambda
    - Add scoped IAM permissions (SQS receive/delete on specific queue ARN)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 14.1, 14.2_

  - [~] 14.2 Update handler to process SQS event records
    - Parse SQS message body to extract S3 event data
    - Handle both ObjectCreated and ObjectRemoved via SQS messages
    - _Requirements: 11.1_

- [ ] 15. AppSync progress notifications (Phase 4)
  - [~] 15.1 Add AppSync schema and notification service
    - Add `FileProcessingStatus` type, mutation, and subscription to AppSync schema
    - Implement `notify_progress()` function with IAM-signed GraphQL mutations
    - Publish status at milestones: STARTED, EXTRACTING_TEXT, EXTRACTING_TOPICS, GENERATING_EMBEDDINGS, COMPLETE, FAILED
    - Ensure notifications are non-blocking (failures don't interrupt processing)
    - Add AppSync IAM permissions to Lambda role (scoped to specific API)
    - Add `APPSYNC_ENDPOINT` environment variable
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_

- [ ] 16. Parallel page extraction (Phase 4)
  - [~] 16.1 Implement parallel page extraction with `concurrent.futures`
    - Use ThreadPoolExecutor for page text extraction
    - Apply parallelism only for documents above a page-count threshold (sequential for small docs)
    - Preserve page ordering in output regardless of extraction parallelism
    - _Requirements: 13.1, 13.2_

  - [ ]* 16.2 Write property test for page order preservation
    - **Property 9: Page Order Preservation Under Parallelism**
    - Output page texts are in same order as original document pages
    - **Validates: Requirement 13.2**

- [~] 17. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Phase 1 (tasks 1-6) delivers ~95% of performance improvement — prioritize these
- Phase 2 (tasks 8-11) adds efficiency and observability
- Phase 3 (task 13) adds batch optimization
- Phase 4 (tasks 14-16) adds scaling — only after pipeline is stable and correct
- `langchain-classic` (SQLRecordManager) is fully removed in task 5.2
- All deletion and record management uses direct SQL — LangChain PGVector is used for insertion convenience only

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.3", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.5", "3.2", "4.2"] },
    { "id": 3, "tasks": ["2.6", "5.1", "5.2"] },
    { "id": 4, "tasks": ["5.3", "7.1", "11.1"] },
    { "id": 5, "tasks": ["8.1", "9.1", "10.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "9.2"] },
    { "id": 7, "tasks": ["13.1"] },
    { "id": 8, "tasks": ["13.2", "14.1"] },
    { "id": 9, "tasks": ["14.2", "15.1", "16.1"] },
    { "id": 10, "tasks": ["16.2"] }
  ]
}
```
