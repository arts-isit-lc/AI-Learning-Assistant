# Requirements Document

## Introduction

This feature adds automatic topic extraction to the AI Learning Assistant. When an instructor uploads a PDF to a module, the system extracts main topics from the file asynchronously using Claude 3 Haiku. The instructor can then trigger module-level aggregation via a "Generate Topics" button to consolidate topics across all files. These aggregated topics serve as a reference for writing the module prompt and are injected into the student chatbot's system prompt as a fallback when no module-level prompt exists.

## Glossary

- **Data_Ingestion_Lambda**: The existing Docker container Lambda function that processes file uploads from S3, inserts file records into the database, and updates the vector store.
- **Text_Generation_Lambda**: The existing Docker container Lambda function that handles student chat interactions, builds system prompts, and streams LLM responses.
- **Topic_Extractor**: The new component within the Data_Ingestion_Lambda responsible for extracting topics from uploaded PDF text using Claude 3 Haiku.
- **Topic_Aggregator**: The new backend component that consolidates per-file topics into a module-level topic list via a manual API call.
- **Module_Files**: The database table storing file records with a JSONB metadata column containing per-file topic extraction results.
- **Course_Modules**: The database table storing module records with a new JSONB generated_topics column for aggregated topic results.
- **Per_File_Topics**: The topics and learning objectives extracted from a single uploaded file, stored in Module_Files.metadata under the topic_extraction key.
- **Generated_Topics**: The consolidated module-level topics stored in Course_Modules.generated_topics, derived from all per-file topics in the module.
- **Staleness**: The condition where the current set of module files differs from the files used to generate the stored Generated_Topics, detected by comparing source_file_ids.
- **Sampling_Strategy**: The method for handling documents exceeding 160,000 characters by selecting the first 20% of pages, evenly spaced middle pages, and the last 10% of pages.
- **ETag**: The S3 object entity tag used as a content hash for idempotency checks during topic extraction.

## Requirements

### Requirement 1: Per-File Topic Extraction on Upload

**User Story:** As an instructor, I want topics to be automatically extracted from my uploaded PDFs, so that the system can identify what subject matter each file covers without manual input.

#### Acceptance Criteria

1. WHEN a PDF file is uploaded to the data ingestion S3 bucket, THE Topic_Extractor SHALL extract text from the PDF, apply the large document handling rules defined in Requirement 2 if necessary, and send the text to Claude 3 Haiku for topic identification.
2. WHEN the Topic_Extractor receives a valid response, THE Topic_Extractor SHALL store the result in the Module_Files.metadata column as JSONB nested under a `topic_extraction` key containing: a `topics` array of strings, a `learning_objectives` array of strings, an `extracted_at` ISO timestamp, a `model` string identifying the LLM used, a `version` integer, and the `s3_etag` of the source file.
3. THE Topic_Extractor SHALL limit per-file extraction to a maximum of 5 topics and 5 learning objectives.
4. IF topic extraction fails for any reason, THEN THE Data_Ingestion_Lambda SHALL continue processing the file upload and vector store update without interruption.
5. WHEN topic extraction fails, THE Data_Ingestion_Lambda SHALL log a warning-level message containing the file identifier and error details.
6. THE Topic_Extractor SHALL apply the idempotency rules defined in Requirement 3 and the retry/parsing rules defined in Requirement 4.

### Requirement 2: Large Document Handling

**User Story:** As an instructor, I want to upload large PDFs without causing timeouts or errors, so that topic extraction works reliably regardless of document size.

#### Acceptance Criteria

1. WHILE the extracted document text is 160,000 characters or fewer, THE Topic_Extractor SHALL send the full text to Claude 3 Haiku.
2. WHILE the extracted document text exceeds 160,000 characters, THE Topic_Extractor SHALL apply the Sampling_Strategy to reduce the text before sending it to Claude 3 Haiku.
3. WHEN the Sampling_Strategy is applied, THE Topic_Extractor SHALL include at minimum 2 pages from the first 20% of the document, up to 8 evenly spaced pages from the middle 60%, and at minimum 2 pages from the last 10% of the document.
4. WHEN the Sampling_Strategy is applied, THE Topic_Extractor SHALL stop including middle section pages once adding the next page would cause the total sampled text to exceed 160,000 characters.
5. IF the extracted document text is empty after processing all pages, THEN THE Topic_Extractor SHALL skip the topic extraction call and leave the file metadata without topic data.

### Requirement 3: Idempotent Extraction via ETag

**User Story:** As a system operator, I want topic extraction to be skipped when file content has not changed, so that the system avoids redundant LLM calls and associated costs.

#### Acceptance Criteria

1. WHEN a file upload event occurs, THE Topic_Extractor SHALL compare the S3 ETag from the event payload against the ETag stored in the file's `topic_extraction` metadata in the Module_Files table.
2. IF the S3 ETag from the event matches the stored ETag in the file's `topic_extraction` metadata, THEN THE Topic_Extractor SHALL not invoke the LLM and shall not update the file's topic_extraction metadata.
3. IF the S3 ETag from the event differs from the stored ETag or no `topic_extraction` metadata exists for the file, THEN THE Topic_Extractor SHALL proceed with topic extraction.
4. WHEN topic extraction completes successfully, THE Topic_Extractor SHALL store the S3 ETag from the event in the file's `topic_extraction` metadata alongside the extracted topics.

### Requirement 4: LLM Response Parsing with Retry

**User Story:** As a system operator, I want robust parsing of LLM responses, so that transient formatting issues do not cause permanent extraction failure.

#### Acceptance Criteria

1. WHEN Claude 3 Haiku returns a response wrapped in markdown code fences (triple backticks, with or without a language identifier on the opening line), THE Topic_Extractor SHALL strip the opening fence line and closing fence before parsing the remaining content as JSON.
2. IF the LLM response cannot be parsed as valid JSON after fence stripping, THEN THE Topic_Extractor SHALL issue a new LLM request, up to a maximum of 3 total attempts (where the initial request counts as the first attempt).
3. IF all 3 parsing attempts fail, THEN THE Topic_Extractor SHALL log a warning containing the attempt count and failure reason, raise an error, and leave the file's topic_extraction metadata unchanged (no partial writes).
4. WHEN the parsed JSON is missing a "topics" field or the "topics" field value is not a list, THE Topic_Extractor SHALL treat the response as a parse failure and count it toward the same 3-attempt retry budget defined in criterion 2.

### Requirement 5: Module-Level Topic Aggregation

**User Story:** As an instructor, I want to generate a consolidated topic list across all files in my module, so that I have a concise reference for writing the module prompt.

#### Acceptance Criteria

1. WHEN the instructor triggers the Generate Topics action for a module, THE Topic_Aggregator SHALL check whether all files in the module have completed per-file topic extraction, where a file is considered complete when its metadata contains a non-empty topics list from a prior extraction.
2. IF not all files have completed per-file extraction, THEN THE Topic_Aggregator SHALL return a processing status indicating the count of ready files and total files.
3. WHEN all files have completed per-file extraction, THE Topic_Aggregator SHALL collect all per-file topics and send them to Claude 3 Haiku for consolidation, retrying up to 3 times on JSON parse failures before giving up.
4. THE Topic_Aggregator SHALL limit consolidated output to a maximum of 7 topics and 7 learning objectives, with no enforced minimum.
5. WHEN the total per-file topics number 5 or fewer and learning objectives number 5 or fewer, THE Topic_Aggregator SHALL pass them through directly without an additional LLM call.
6. WHEN consolidation completes, THE Topic_Aggregator SHALL store the result in Course_Modules.generated_topics as JSONB including topics, learning_objectives, generated_at timestamp, model identifier, source_file_count, and source_file_ids.
7. IF the consolidation LLM call fails after 3 retry attempts, THEN THE Topic_Aggregator SHALL return an error response indicating consolidation failure without modifying the existing stored generated_topics.
8. IF the module contains zero files when the instructor triggers Generate Topics, THEN THE Topic_Aggregator SHALL return a response indicating no files are available with an empty topics list and an empty learning objectives list.

### Requirement 6: Generate Topics API Endpoint

**User Story:** As a frontend developer, I want a dedicated API endpoint for topic generation, so that the instructor UI can trigger and display module-level topics.

#### Acceptance Criteria

1. THE System SHALL expose a POST /instructor/generate_topics endpoint that accepts a required module_id query parameter and returns an HTTP 200 JSON response for all successful operations.
2. WHEN all files in the module have completed per-file topic extraction, THE System SHALL return a JSON response containing a topics array (maximum 7 items), a learning_objectives array (maximum 7 items), a source_file_ids array listing the file identifiers used, and a source_file_count integer.
3. WHEN one or more files in the module lack extracted topic metadata, THE System SHALL return a JSON response with status "processing", a ready count indicating files with completed extraction, and a total count indicating all files in the module.
4. WHEN the module has no files, THE System SHALL return a JSON response with status "no_files" and empty topics and learning_objectives arrays.
5. IF the module_id query parameter is missing or does not match an existing module, THEN THE System SHALL return an HTTP 400 response with an error message indicating the invalid or missing parameter.

### Requirement 7: Staleness Detection

**User Story:** As an instructor, I want to know when my generated topics are outdated due to file changes, so that I can regenerate them if needed.

#### Acceptance Criteria

1. THE Topic_Aggregator SHALL store the list of source_file_ids and their corresponding s3_etags used during aggregation within the Generated_Topics record.
2. WHEN the instructor opens the module edit page, THE System SHALL consider the Generated_Topics stale IF any of the following conditions are true: the current set of file IDs in the module differs from the source_file_ids in Generated_Topics, OR any file's current s3_etag (from its topic_extraction metadata) differs from the etag stored in the Generated_Topics record for that file.
3. WHEN Generated_Topics are stale, THE Frontend SHALL display a visible warning message near the generated topics section indicating that topics may be outdated.
4. WHEN the instructor regenerates topics and the new source_file_ids and etags match the current state, THE Frontend SHALL remove the staleness warning.
5. IF no Generated_Topics record exists for the module, THEN THE Frontend SHALL not display any staleness warning.

### Requirement 8: System Prompt Topic Injection

**User Story:** As a student, I want the chatbot to be aware of the module's core topics even when the instructor has not written a custom prompt, so that conversations stay focused on relevant subject matter.

#### Acceptance Criteria

1. WHILE the module_prompt field is empty or contains only whitespace, THE Text_Generation_Lambda SHALL inject the Generated_Topics into the system prompt.
2. WHILE the module_prompt field contains non-whitespace content, THE Text_Generation_Lambda SHALL omit the Generated_Topics from the system prompt.
3. WHEN injecting topics, THE Text_Generation_Lambda SHALL format them as a bulleted list under a "Primary concepts covered by this module:" heading followed by a "Key learning objectives:" heading, and append the formatted section to the system prompt after the course_system_prompt and before the retrieved context section.
4. IF the Generated_Topics record is null or contains no topics, THEN THE Text_Generation_Lambda SHALL construct the system prompt without any topic injection.
5. WHEN injecting topics, THE Text_Generation_Lambda SHALL include a maximum of 7 topics and a maximum of 7 learning objectives from the Generated_Topics record.

### Requirement 9: Database Schema Changes

**User Story:** As a system operator, I want the database schema to support structured topic storage, so that topic data can be queried and updated reliably.

#### Acceptance Criteria

1. THE System SHALL alter the Module_Files.metadata column from TEXT type to JSONB type, converting empty strings and NULL values to SQL NULL during migration, and casting any remaining non-empty values to JSONB such that the migration fails if a non-empty value is not valid JSON.
2. THE System SHALL add a generated_topics column of type JSONB with a default of NULL to the Course_Modules table.
3. WHEN topic extraction completes for a file, THE System SHALL store the result nested under a `topic_extraction` key within the Module_Files.metadata JSONB, containing at minimum a `topics` array and an `extracted_at` timestamp, preserving any other existing keys in the metadata object.
4. IF the schema migration is executed against a database where the metadata column is already of type JSONB, THEN THE System SHALL complete without error.

### Requirement 10: Frontend Generate Topics UI

**User Story:** As an instructor, I want a button on the module edit page to generate topics and see the results, so that I can use them as reference when writing my module prompt.

#### Acceptance Criteria

1. THE Frontend SHALL display a "Generate Topics" button on the module create and edit pages.
2. WHILE the module has no saved or pending-upload files, THE Frontend SHALL disable the "Generate Topics" button.
3. WHEN the instructor clicks "Generate Topics" and the backend returns a processing status, THE Frontend SHALL display an informational message showing the count of ready files versus total files (e.g., "3 of 5 files ready").
4. WHEN the instructor clicks "Generate Topics" and aggregation succeeds, THE Frontend SHALL display the generated topics and learning objectives each as a list of up to 7 items below the button.
5. WHILE topic generation is in progress, THE Frontend SHALL display a loading indicator on the button, disable the button to prevent additional clicks, and abort the request with an error message if no response is received within 30 seconds.
6. IF the generate topics API call fails or times out, THEN THE Frontend SHALL display an error message indicating the failure and re-enable the "Generate Topics" button.
7. WHEN generated topics exist and the current module file list differs from the source file list used for generation, THE Frontend SHALL display a staleness warning indicating that topics may be outdated due to file changes.
