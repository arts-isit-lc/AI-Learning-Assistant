# Requirements Document

## Introduction

This document defines the functional requirements for optimizing the AI Learning Assistant's data ingestion pipeline. The current pipeline reprocesses all files in a module on every upload, uses intermediate S3 round-trips, and provides no progress feedback. These requirements specify the behavior of an incremental, per-file processing system that eliminates redundant work while maintaining correctness.

The architecture principle is: **"PGVector is the source of truth. LangChain is optional convenience."** All vector record management uses direct SQL operations with `file_id` as the primary partition key.

## Glossary

- **Data_Ingestion_Lambda**: The Docker container Lambda function that processes uploaded files into vector embeddings for RAG retrieval
- **Incremental_Indexing_Engine**: The component that performs per-file direct SQL delete+insert operations on the vectorstore
- **Content_Deduplication_Checker**: The component that compares content hashes to skip reprocessing of unchanged files
- **File_Deletion_Handler**: The component that removes vector embeddings when a file is deleted from S3
- **In_Memory_Processor**: The component that extracts text and chunks documents without intermediate S3 storage
- **Batch_Embedding_Generator**: The component that groups chunks into batches for Bedrock API calls
- **Processing_Metrics_Recorder**: The component that tracks per-file processing metrics in the Module_Files metadata
- **SQS_FIFO_Buffer**: The SQS FIFO queue that serializes per-module processing and provides burst protection (Phase 4)
- **Progress_Notification_Service**: The AppSync-based service that sends real-time status updates to instructors (Phase 4)
- **Vectorstore**: The PostgreSQL + pgvector database table (`langchain_pg_embedding`) storing document chunk embeddings
- **Module_Files**: The PostgreSQL table tracking uploaded files and their processing metadata
- **content_hash**: A SHA-256 hash of file content used as the primary deduplication mechanism
- **file_id**: The UUID primary key from Module_Files used to partition vector embeddings per file
- **collection_id**: The identifier for a module's vector collection in pgvector

## Requirements

### Requirement 1: Mandatory file_id in Chunk Metadata

**User Story:** As a system operator, I want every vector chunk to include a `file_id` in its metadata, so that chunks can be individually managed (deleted, updated) per file without affecting other files.

#### Acceptance Criteria

1. WHEN the Data_Ingestion_Lambda processes a file into chunks, THE Incremental_Indexing_Engine SHALL include the `file_id` field in every chunk's metadata unconditionally
2. IF a chunk is produced with any validation failure (missing or invalid `file_id`, malformed content, missing source data, or other metadata violations), THEN THE Data_Ingestion_Lambda SHALL reject the chunk and raise a processing error
3. THE Incremental_Indexing_Engine SHALL include `source`, `doc_id`, `page_numbers`, `chunk_index`, and `content_hash` alongside `file_id` in every chunk's metadata

### Requirement 2: Direct SQL Incremental Indexing

**User Story:** As a system operator, I want file processing to only affect the uploaded file's chunks in the vectorstore, so that uploading one file does not reprocess or disrupt embeddings for other files in the same module.

#### Acceptance Criteria

1. WHEN a file is uploaded, THE Incremental_Indexing_Engine SHALL delete only the chunks matching that file's `file_id` from the vectorstore using direct SQL (`DELETE FROM langchain_pg_embedding WHERE cmetadata->>'file_id' = %s AND collection_id = %s`)
2. WHEN a file is uploaded, THE Incremental_Indexing_Engine SHALL insert new chunks for that file only, leaving all other files' chunks unchanged
3. THE Incremental_Indexing_Engine SHALL execute the delete and insert operations within a single database transaction to guarantee atomicity
4. THE Data_Ingestion_Lambda SHALL NOT use the `SQLRecordManager` or `cleanup="full"` mode for vectorstore operations
5. THE Data_Ingestion_Lambda SHALL NOT list or download other files in the module during processing of a single file upload

### Requirement 3: Content Hash Deduplication

**User Story:** As a system operator, I want the system to skip reprocessing when identical content is re-uploaded, so that redundant work and Bedrock API costs are eliminated.

#### Acceptance Criteria

1. WHEN a file is uploaded, THE Content_Deduplication_Checker SHALL compute a SHA-256 hash of the file content
2. WHEN the computed content hash matches the stored `content_hash` in Module_Files for that file, THE Data_Ingestion_Lambda SHALL skip vectorstore processing entirely
3. WHEN the computed content hash differs from the stored value, THE Data_Ingestion_Lambda SHALL proceed with full processing and update the stored `content_hash` after successful completion
4. WHEN no previous `content_hash` exists for the file, THE Data_Ingestion_Lambda SHALL proceed with full processing and store the computed hash

### Requirement 4: File Deletion Cleanup

**User Story:** As an instructor, I want deleted files to no longer appear in student search results, so that outdated or incorrect content is removed from the knowledge base.

#### Acceptance Criteria

1. WHEN an S3 ObjectRemoved event is received, THE File_Deletion_Handler SHALL resolve the `file_id` from the Module_Files table using module_id, filename, and filetype
2. WHEN the `file_id` is resolved, THE File_Deletion_Handler SHALL execute `DELETE FROM langchain_pg_embedding WHERE cmetadata->>'file_id' = %s` to remove all associated vector embeddings
3. WHEN file deletion is complete, THE File_Deletion_Handler SHALL update the `processing_status` column in Module_Files to `'deleted'`
4. IF the `file_id` cannot be resolved from Module_Files, THEN THE File_Deletion_Handler SHALL log a warning and skip the deletion without raising an error

### Requirement 5: Chunking Strategy Benchmarking

**User Story:** As a system architect, I want empirical data comparing SemanticChunker vs RecursiveCharacterTextSplitter, so that the Phase 2 chunking decision is informed by measured retrieval quality and cost.

#### Acceptance Criteria

1. WHEN Phase 1 benchmark is executed, THE Data_Ingestion_Lambda SHALL measure retrieval precision and recall for both SemanticChunker and RecursiveCharacterTextSplitter on a representative query set
2. WHEN Phase 1 benchmark is executed, THE Data_Ingestion_Lambda SHALL record the total Bedrock API call count and estimated cost per document for each chunking strategy
3. WHEN Phase 1 benchmark is executed, THE Data_Ingestion_Lambda SHALL record chunk size distribution and count for each strategy

### Requirement 6: In-Memory Document Processing

**User Story:** As a system operator, I want text extraction and chunking to occur entirely in memory, so that the 3N S3 API calls per file (upload, download, delete per page) are eliminated.

#### Acceptance Criteria

1. WHEN processing a file on the normal processing path, THE In_Memory_Processor SHALL download the file from S3 exactly once; re-downloads are permitted for error recovery and retry scenarios
2. WHEN extracting text, THE In_Memory_Processor SHALL store all page text in memory without uploading intermediate files to S3
3. WHEN chunking text, THE In_Memory_Processor SHALL operate on the full concatenated document text (cross-page aware) rather than chunking each page independently
4. THE In_Memory_Processor SHALL reuse the extracted text for both topic extraction and vectorstore chunking without re-downloading the file

### Requirement 7: Processing Metrics Recording

**User Story:** As a system operator, I want per-file processing metrics stored in the database, so that I can identify slow file types, excessive chunk counts, and recurring failures.

#### Acceptance Criteria

1. WHEN file processing completes successfully, THE Processing_Metrics_Recorder SHALL store `processing_duration_ms`, `chunk_count`, and `embedding_count` in the Module_Files.metadata JSONB column
2. WHEN file processing fails, THE Processing_Metrics_Recorder SHALL store `last_error` and `retry_count` in the Module_Files.metadata JSONB column
3. THE Processing_Metrics_Recorder SHALL update the `processing_status` column to reflect the current state (`pending`, `processing`, `complete`, `failed`, `deleted`)

### Requirement 8: Chunking Strategy Switch

**User Story:** As a system architect, I want to switch from SemanticChunker to RecursiveCharacterTextSplitter if benchmark data supports it, so that the hidden double-embedding cost is eliminated while maintaining retrieval quality.

#### Acceptance Criteria

1. WHERE Phase 1 benchmark data demonstrates RecursiveCharacterTextSplitter delivers comparable retrieval quality, THE Data_Ingestion_Lambda SHALL allow the operator to choose either SemanticChunker or RecursiveCharacterTextSplitter with tuned `chunk_size` and `chunk_overlap` parameters; the switch to RecursiveCharacterTextSplitter SHALL NOT be permitted without supporting benchmark evidence
2. WHEN using RecursiveCharacterTextSplitter, THE Data_Ingestion_Lambda SHALL NOT generate any Bedrock embedding calls for chunking decisions (only for final chunk embeddings)

### Requirement 9: Batch Embedding API Calls

**User Story:** As a system operator, I want embedding generation to use batch API calls, so that Bedrock API call count is reduced by approximately 90%.

#### Acceptance Criteria

1. WHEN generating embeddings, THE Batch_Embedding_Generator SHALL group chunks into batches of up to 20 texts per API call
2. WHEN a batch call receives a ThrottlingException, THE Batch_Embedding_Generator SHALL retry with exponential backoff (initial 1s, max 30s, up to 5 retries)
3. THE Batch_Embedding_Generator SHALL return exactly N embedding vectors for N input chunks, maintaining the same order as the input

### Requirement 10: Memory Tuning

**User Story:** As a system operator, I want the Lambda memory allocation optimized based on benchmark data, so that processing performance is balanced against cost.

#### Acceptance Criteria

1. THE Data_Ingestion_Lambda SHALL be configured with a minimum of 1024 MB memory allocation
2. WHEN benchmark data shows measurable improvement at 2048 MB, THE Data_Ingestion_Lambda SHALL be configured with 2048 MB memory allocation; IF benchmarks do not show improvement at 2048 MB, THEN THE Data_Ingestion_Lambda SHALL fall back to 1024 MB minimum

### Requirement 11: SQS FIFO Queue Buffering

**User Story:** As a system operator, I want burst uploads to be serialized per module via a FIFO queue, so that concurrent Lambda invocations for the same module do not cause thundering herd on RDS or race conditions on the vectorstore.

#### Acceptance Criteria

1. WHEN an S3 ObjectCreated or ObjectRemoved event occurs, THE SQS_FIFO_Buffer SHALL receive the event message with `MessageGroupId` set to `{course_id}/{module_id}`
2. WHILE messages are queued for the same module, THE SQS_FIFO_Buffer SHALL deliver them one at a time (FIFO within the message group)
3. IF a message fails processing 3 times, THEN THE SQS_FIFO_Buffer SHALL attempt to route it to the Dead Letter Queue (DLQ delivery itself is best-effort and may fail)
4. THE SQS_FIFO_Buffer SHALL be configured with ContentBasedDeduplication enabled, VisibilityTimeout of 720 seconds, and MessageRetentionPeriod of 86400 seconds

### Requirement 12: AppSync Progress Notifications

**User Story:** As an instructor, I want real-time feedback on file processing status, so that I know whether my uploaded materials are ready for student use.

#### Acceptance Criteria

1. WHEN file processing begins, THE Progress_Notification_Service SHALL publish a status update with `status: STARTED` to the AppSync subscription
2. WHEN file processing reaches key milestones (text extraction, topic extraction, embedding generation), THE Progress_Notification_Service SHALL publish status updates with the corresponding status and progress percentage
3. WHEN file processing completes with an explicitly successful outcome, THE Progress_Notification_Service SHALL publish a status update with `status: COMPLETE` and `progress_pct: 100`; THE Progress_Notification_Service SHALL NOT publish COMPLETE for ambiguous end states
4. WHEN file processing fails, THE Progress_Notification_Service SHALL publish a status update with `status: FAILED` and an error message
5. IF the notification service fails to publish, THEN THE Data_Ingestion_Lambda SHALL continue processing without interruption (notifications are non-blocking and best-effort; lost completion notifications are acceptable as users can check file status through other means)

### Requirement 13: Parallel Page Extraction

**User Story:** As a system operator, I want page text extraction to execute in parallel where beneficial, so that extraction time is reduced for large documents.

#### Acceptance Criteria

1. WHEN extracting text from a multi-page document, THE In_Memory_Processor SHALL use concurrent processing for page extraction; WHERE parallelism overhead would slow down extraction for small documents, THE In_Memory_Processor SHALL use sequential processing instead
2. THE In_Memory_Processor SHALL preserve page ordering in the output regardless of extraction parallelism

### Requirement 14: Reserved Concurrency Tuning

**User Story:** As a system operator, I want Lambda concurrency limited to prevent RDS connection pool exhaustion, so that the database remains available under burst upload conditions.

#### Acceptance Criteria

1. THE Data_Ingestion_Lambda SHALL be configured with reserved concurrency to limit simultaneous invocations
2. WHILE reserved concurrency is in effect, THE SQS_FIFO_Buffer SHALL retain messages until capacity is available rather than dropping them

### Requirement 15: Error Handling and Recovery

**User Story:** As a system operator, I want robust error handling with clear recovery paths, so that transient failures do not result in permanently lost or corrupted data.

#### Acceptance Criteria

1. IF the Data_Ingestion_Lambda reaches memory limits during processing, THEN THE Data_Ingestion_Lambda SHALL always activate the page-by-page streaming mode fallback (processing pages sequentially rather than holding all in memory); this fallback activation is guaranteed and unconditional when memory limits are reached
2. IF Bedrock returns a ThrottlingException, THEN THE Batch_Embedding_Generator SHALL first check current throttling state and wait before initiating the retry sequence with exponential backoff with jitter (initial 1s, max 30s, 5 retries)
3. IF two concurrent Lambda invocations attempt to process the same module, THEN THE Incremental_Indexing_Engine SHALL use PostgreSQL advisory locks (`pg_try_advisory_lock`) to serialize access
4. IF advisory lock acquisition fails, THEN THE Data_Ingestion_Lambda SHALL raise an exception to trigger a retry
5. IF processing fails after the database record is inserted but before embeddings complete, THEN THE Data_Ingestion_Lambda SHALL detect the `processing` status on retry and resume from the embedding step
6. THE Incremental_Indexing_Engine SHALL rely on PostgreSQL transaction atomicity to prevent orphan chunks from partial DELETE+INSERT failures

### Requirement 16: Processing Status Tracking

**User Story:** As a system operator, I want each file's processing state tracked in the database, so that retries can resume from the correct step and operators can identify stuck files.

#### Acceptance Criteria

1. WHEN a file upload is received, THE Data_Ingestion_Lambda SHALL set `processing_status` to `'processing'` before beginning vectorstore operations
2. WHEN vectorstore operations complete successfully, THE Data_Ingestion_Lambda SHALL set `processing_status` to `'complete'`
3. IF vectorstore operations fail after all retries, THEN THE Data_Ingestion_Lambda SHALL set `processing_status` to `'failed'`
4. WHEN a file is deleted, THE File_Deletion_Handler SHALL set `processing_status` to `'deleted'`; file deletion SHALL always take precedence over processing status — IF a file is deleted while processing is ongoing, THEN the final status SHALL be `'deleted'` regardless of processing outcome

### Requirement 17: Database Schema Extension

**User Story:** As a system operator, I want the Module_Files table extended with optimization columns, so that content deduplication, processing status, and chunk tracking are supported.

#### Acceptance Criteria

1. THE Module_Files table SHALL include a `content_hash` column of type TEXT for storing SHA-256 hashes of file content
2. THE Module_Files table SHALL include a `processing_status` column of type TEXT with a default value of `'pending'`
3. THE Module_Files table SHALL include a `last_processed_at` column of type TIMESTAMPTZ
4. THE Module_Files table SHALL include a `chunk_count` column of type INTEGER for tracking the number of vectorstore chunks per file; a value of zero is valid for files that legitimately produce no content (empty files, unsupported formats)
