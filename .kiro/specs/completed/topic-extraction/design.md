# Technical Design Document

## Overview

This document describes the technical design for the Topic Extraction feature. It covers the system architecture, component interactions, data models, and implementation details for all three layers: per-file extraction, module-level aggregation, and system prompt injection.

#[[file:../../docs/topic_extraction_feature_plan.md]]

## Architecture

### Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                          │
│  InstructorEditCourse / InstructorNewModule                                   │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────────────┐    │
│  │ File Uploader    │  │ Generate Topics  │  │ Topics Display + Staleness│    │
│  │ (existing)       │  │ Button (new)     │  │ Warning (new)             │    │
│  └────────┬─────────┘  └────────┬─────────┘  └───────────────────────────┘    │
│           │                      │                                             │
└───────────┼──────────────────────┼─────────────────────────────────────────────┘
            │                      │
            ▼                      ▼
┌───────────────────┐   ┌──────────────────────────────┐
│ S3 DataIngestion  │   │ API Gateway                   │
│ Bucket            │   │ POST /instructor/generate_topics │
└────────┬──────────┘   └──────────────┬───────────────┘
         │                             │
         ▼                             ▼
┌────────────────────────┐   ┌─────────────────────────────┐
│ Data Ingestion Lambda  │   │ Instructor Function Lambda   │
│ (Docker, Python 3.11)  │   │ (Node.js 22)                 │
│                        │   │                              │
│ ┌────────────────────┐ │   │ ┌──────────────────────────┐│
│ │ Topic Extractor    │ │   │ │ Topic Aggregator         ││
│ │ - extract_text     │ │   │ │ - query file metadata    ││
│ │ - call_haiku       │ │   │ │ - call_haiku_consolidate ││
│ │ - update_metadata  │ │   │ │ - store generated_topics ││
│ └────────────────────┘ │   │ └──────────────────────────┘│
└────────────┬───────────┘   └──────────────┬──────────────┘
             │                              │
             ▼                              ▼
┌────────────────────────────────────────────────────────────┐
│                    Amazon Bedrock                            │
│            Claude 3 Haiku (anthropic.claude-3-haiku-20240307-v1:0)  │
└────────────────────────────────────────────────────────────┘
             │                              │
             ▼                              ▼
┌────────────────────────────────────────────────────────────┐
│                    PostgreSQL (via RDS Proxy)                │
│  ┌──────────────────────┐  ┌─────────────────────────────┐ │
│  │ Module_Files          │  │ Course_Modules              │ │
│  │ .metadata (JSONB)     │  │ .generated_topics (JSONB)   │ │
│  └──────────────────────┘  └─────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────────────────────────┐
│ Text Generation Lambda (Docker, Python 3.11)                │
│ - get_module_topics() → inject into system prompt           │
└────────────────────────────────────────────────────────────┘
```

### Data Flow: Per-File Extraction (Layer 1)

```
S3 ObjectCreated event
    │
    ▼
data_ingestion Lambda handler()
    │
    ├── 1. insert_file_into_db(module_id, file_name, file_type, ...)
    ├── 2. file_id = get_file_id_from_db(module_id, file_name, file_type)
    ├── 3. s3_etag = record['s3']['object']['eTag']
    │
    ├── 4. [NON-BLOCKING] Topic Extraction:
    │       ├── should_extract_topics(file_id, s3_etag)
    │       │     └── Query Module_Files.metadata WHERE file_id
    │       │     └── Compare stored ETag vs event ETag
    │       │
    │       ├── extract_text_from_pdf(bucket, file_key)
    │       │     └── Download PDF from S3
    │       │     └── PyMuPDF page-by-page extraction (+ OCR fallback)
    │       │     └── If total_chars > 160K → sample_large_document()
    │       │
    │       ├── call_haiku_for_topics(text)
    │       │     └── Build prompt + text payload
    │       │     └── bedrock_runtime.invoke_model(Haiku)
    │       │     └── Parse JSON response (strip fences, validate, retry)
    │       │
    │       └── update_file_metadata(file_id, topics, s3_etag)
    │             └── Read existing metadata → merge → write back
    │
    └── 5. update_vectorstore_from_s3(bucket, course_id, module_id, file_id)
            └── [EXISTING, UNCHANGED]
```

### Data Flow: Module-Level Aggregation (Layer 2)

```
POST /instructor/generate_topics?module_id=xxx
    │
    ▼
instructorFunction Lambda handler
    │
    ├── 1. Query Module_Files WHERE module_id → get all file_ids + metadata
    │
    ├── 2. Check: do all files have topic_extraction.topics?
    │       ├── NO → return { status: "processing", ready: N, total: M }
    │       └── YES → continue
    │
    ├── 3. Collect all topics + objectives from all files
    │       └── Build source_file_ids + source_file_etags arrays
    │
    ├── 4. If total_topics ≤ 5 AND total_objectives ≤ 5:
    │       └── Direct passthrough (no LLM call)
    │       Otherwise:
    │       └── call_haiku_for_consolidation(all_topics, all_objectives)
    │
    ├── 5. Store in Course_Modules.generated_topics
    │
    └── 6. Return consolidated result to frontend
```

### Data Flow: System Prompt Injection (Layer 3)

```
Student sends chat message
    │
    ▼
text_generation Lambda handler
    │
    ├── ... existing setup (session, retriever, etc.) ...
    │
    ├── should_inject_topics(module_prompt)
    │     └── Returns True if module_prompt is empty/whitespace
    │
    ├── get_module_topics(module_id, connection)
    │     └── SELECT generated_topics FROM Course_Modules WHERE module_id
    │     └── Format as bulleted list string
    │
    └── Build system_prompt with topics section inserted
          └── SYSTEM_LEVEL_PROMPT + topic + topics_section + course_prompt + module_prompt + context
```

## Data Models

### Module_Files Table (Modified)

```sql
-- Migration: ALTER metadata column type
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Module_Files'
        AND column_name = 'metadata'
        AND data_type = 'text'
    ) THEN
        ALTER TABLE "Module_Files"
        ALTER COLUMN metadata TYPE JSONB
        USING CASE
            WHEN metadata = '' THEN NULL
            WHEN metadata IS NULL THEN NULL
            ELSE metadata::jsonb
        END;
    END IF;
END $$;
```

**metadata JSONB structure:**

```json
{
    "topic_extraction": {
        "topics": ["Topic A", "Topic B", "Topic C"],
        "learning_objectives": ["Objective 1", "Objective 2"],
        "extracted_at": "2026-06-06T12:00:00Z",
        "model": "anthropic.claude-3-haiku-20240307-v1:0",
        "version": 1,
        "s3_etag": "d41d8cd98f00b204e9800998ecf8427e"
    }
}
```

### Course_Modules Table (New Column)

```sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'Course_Modules'
        AND column_name = 'generated_topics'
    ) THEN
        ALTER TABLE "Course_Modules"
        ADD COLUMN generated_topics JSONB DEFAULT NULL;
    END IF;
END $$;
```

**generated_topics JSONB structure:**

```json
{
    "topics": ["Consolidated Topic 1", "Consolidated Topic 2"],
    "learning_objectives": ["Objective 1", "Objective 2"],
    "generated_at": "2026-06-06T12:00:00Z",
    "model": "anthropic.claude-3-haiku-20240307-v1:0",
    "source_file_count": 5,
    "source_file_ids": ["uuid-1", "uuid-2", "uuid-3"],
    "source_file_etags": {
        "uuid-1": "etag-abc",
        "uuid-2": "etag-def",
        "uuid-3": "etag-ghi"
    }
}
```

## Components and Interfaces

### Topic Extractor (data_ingestion Lambda)

New module: `cdk/data_ingestion/src/topic_extraction.py`

```python
# Module-level constants
DIRECT_SEND_LIMIT = 160000  # ~40K tokens
# NOTE: Hard-coded to Haiku for cost/speed. Make configurable via SSM in future.
TOPIC_EXTRACTION_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"

# Public functions:
def should_extract_topics(file_id: str, s3_etag: str, connection) -> bool
def extract_text_from_pdf(bucket: str, file_key: str) -> str
def sample_large_document(pages: list, target_chars: int = 160000) -> str
def call_haiku_for_topics(full_text: str, bedrock_client) -> dict
def update_file_metadata(file_id: str, topics: dict, s3_etag: str, connection) -> None
```

**Responsibilities:**
- PDF text extraction (PyMuPDF + OCR fallback)
- Large document sampling
- LLM invocation with retry/parsing
- Metadata storage (merge, not overwrite)
- ETag-based idempotency

### Topic Aggregator (instructorFunction Lambda)

New route handler in the existing `instructorFunction.handler`:

```javascript
// New case in instructorFunction router:
case 'generate_topics':
    return await generateModuleTopics(module_id, dbClient, bedrockClient);
```

**Function: `generateModuleTopics(module_id, dbClient, bedrockClient)`**

```javascript
// 1. Query all Module_Files for module_id
// 2. Check completion status
// 3. Collect per-file topics
// 4. If ≤5 topics total → passthrough
// 5. Else → call Haiku consolidation
// 6. Store in Course_Modules.generated_topics
// 7. Return result
```

### System Prompt Injector (text_generation Lambda)

New functions added to `cdk/text_generation/src/helpers/chat.py`:

```python
def should_inject_topics(module_prompt: str) -> bool
def get_module_topics(module_id: str, connection) -> str
```

**Integration point:** Inside `get_response_streaming()`, before system prompt assembly.

## API Design

### POST /instructor/generate_topics

**Request:**
```
POST /instructor/generate_topics?module_id={uuid}
Authorization: instructorAuthorizer
```

**Response (success):**
```json
{
    "topics": ["Topic 1", "Topic 2", "Topic 3"],
    "learning_objectives": ["Objective 1", "Objective 2"],
    "source_file_count": 3,
    "source_file_ids": ["uuid-1", "uuid-2", "uuid-3"],
    "source_file_etags": {
        "uuid-1": "etag-abc",
        "uuid-2": "etag-def",
        "uuid-3": "etag-ghi"
    },
    "generated_at": "2026-06-06T12:00:00Z"
}
```

**Response (processing):**
```json
{
    "status": "processing",
    "ready": 3,
    "total": 5
}
```

**Response (no files):**
```json
{
    "status": "no_files",
    "topics": [],
    "learning_objectives": []
}
```

**Response (error):**
```json
{
    "status": "error",
    "message": "Topic consolidation failed after 3 attempts"
}
```

## LLM Prompt Contracts

### Per-File Extraction Prompt

```
Analyze this educational document and extract the core subject matter.

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
{extracted_text}
```

### Consolidation Prompt

```
You are analyzing the combined topics from all course materials in a single module.
Multiple documents have been analyzed individually and their topics extracted.

Here are all the topics found across {file_count} documents:
{topics_list as bullet points}

Here are all the learning objectives found:
{objectives_list as bullet points}

Consolidate these into:
- "topics": The overarching main topics (maximum 7). Remove duplicates and merge
  overlapping topics. Only keep topics that represent core subject matter.
- "learning_objectives": The key learning objectives (maximum 7). Merge similar
  objectives and keep only the most important.

Do not set a minimum. If only 1-2 core topics exist, return only those.
Return valid JSON only, no markdown formatting:
{"topics": [...], "learning_objectives": [...]}
```

### Expected Output Schema (both prompts)

```json
{
    "topics": ["string", "..."],
    "learning_objectives": ["string", "..."]
}
```

Validation rules:
- `topics` must be present and be an array
- Each topic must be a non-empty string
- Maximum 5 items for per-file extraction, 7 for consolidation
- `learning_objectives` is optional (extraction succeeds without it)

## Sampling Strategy (Large Documents)

```
Input: all_pages (list of page text strings), total_chars > 160,000

Algorithm:
1. first_count = max(2, total_pages // 5)        → first 20%
2. last_count = max(2, total_pages // 10)         → last 10%
3. first_section = pages[0:first_count]
4. last_section = pages[-last_count:]
5. middle_budget = 160,000 - len(first) - len(last)
6. middle_pages = pages[first_count : total_pages - last_count]
7. step = max(1, len(middle_pages) // 8)          → ~8 evenly spaced
8. Sample middle pages at interval `step` until budget exhausted

Output: first_section + separator + sampled_middle + separator + last_section
```

## Infrastructure Changes

### OpenAPI Specification Addition

```yaml
/instructor/generate_topics:
  options:
    summary: CORS support
    description: Enable CORS by returning correct headers
    responses:
      200:
        $ref: "#/components/responses/Success"
    x-amazon-apigateway-integration:
      type: mock
      requestTemplates:
        application/json: |
          { "statusCode" : 200 }
      responses:
        default:
          statusCode: "200"
          responseParameters:
            method.response.header.Access-Control-Allow-Headers: "'Content-Type,X-Amz-Date,Authorization,X-Api-Key'"
            method.response.header.Access-Control-Allow-Methods: "'*'"
            method.response.header.Access-Control-Allow-Origin: "'*'"
          responseTemplates:
            application/json: |
              {}
  post:
    tags:
      - Instructor
    summary: Generate consolidated topics for a module
    operationId: instructor_generate_topics_POST
    parameters:
      - in: query
        name: module_id
        required: true
        description: ID of the module
        schema:
          type: string
    responses:
      "200":
        description: Topics generated or processing status
      "400":
        description: Bad Request
      "401":
        description: Unauthorized
      "500":
        description: Internal Server Error
    security:
      - instructorAuthorizer: []
    x-amazon-apigateway-integration:
      uri:
        Fn::Sub: "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${instructorFunction.Arn}/invocations"
      passthroughBehavior: "when_no_match"
      httpMethod: "POST"
      type: "aws_proxy"
```

### IAM Permissions

No changes needed:
- `data_ingestion` Lambda already has `bedrockPolicyStatement` which includes Haiku
- `instructorFunction` Lambda uses `dbLambdaRole` which already has Bedrock Haiku permissions

## Error Handling

| Component | Error Type | Handling |
|---|---|---|
| Topic Extractor | Bedrock throttle/timeout | Log warning, skip extraction, continue pipeline |
| Topic Extractor | Invalid JSON (after 3 retries) | Log warning, leave metadata NULL |
| Topic Extractor | PDF extraction failure | Log warning, skip, continue pipeline |
| Topic Extractor | DB write failure | Log warning, no impact on pipeline |
| Topic Aggregator | Bedrock throttle/timeout | Return HTTP 500 error response |
| Topic Aggregator | Invalid JSON (after 3 retries) | Return error, keep existing generated_topics |
| Topic Aggregator | DB query failure | Return HTTP 500 error response |
| Prompt Injector | DB query failure | Log warning, build prompt without topics |
| Prompt Injector | Malformed JSONB | Log warning, build prompt without topics |

## Correctness Properties

### Property 1: Non-blocking guarantee
Topic extraction failure in `data_ingestion` must never prevent the file upload or vectorstore update from completing.

**Validates: Requirements 1.4, 1.5**

### Property 2: Idempotency
Given the same file content (same ETag), the system produces the same extraction result and does not make redundant LLM calls.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 3: Metadata preservation
Writing topic_extraction metadata must never overwrite other keys in the metadata JSONB object.

**Validates: Requirements 9.3**

### Property 4: Staleness accuracy
The staleness indicator must detect all cases where generated_topics does not reflect the current module file state (file added, removed, or content changed).

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 5: Prompt injection correctness
Topics are injected if and only if module_prompt is empty/whitespace AND generated_topics exists with a non-empty topics array.

**Validates: Requirements 8.1, 8.2, 8.4**

### Property 6: Schema migration safety
The migration must be idempotent — running it twice produces no error and no data loss.

**Validates: Requirements 9.1, 9.2, 9.4**

## Testing Strategy

### Unit Tests
- `sample_large_document()`: Verify correct page selection and budget enforcement
- `call_haiku_for_topics()`: Mock Bedrock client, test retry logic, fence stripping, validation
- `should_extract_topics()`: Test ETag comparison logic
- `should_inject_topics()`: Test empty/whitespace/content module_prompt cases
- `get_module_topics()`: Test formatting output from various JSONB structures

### Integration Tests
- Full extraction pipeline: Upload a PDF to S3, verify metadata is written to Module_Files
- Aggregation endpoint: Seed file metadata, call endpoint, verify consolidated result
- Prompt injection: Seed generated_topics, invoke text_generation, verify system prompt content

### CDK Assertion Tests
- Verify new API endpoint exists in synthesized template
- Verify IAM permissions are unchanged (no new permissions needed)
- Verify DB migration SQL is included in initializer

## File Changes Summary

| File | Change Type | Description |
|---|---|---|
| `cdk/data_ingestion/src/topic_extraction.py` | NEW | Topic extractor module |
| `cdk/data_ingestion/src/main.py` | MODIFY | Add topic extraction call in handler |
| `cdk/lambda/lib/instructorFunction.js` | MODIFY | Add generate_topics route |
| `cdk/text_generation/src/helpers/chat.py` | MODIFY | Add topic injection functions |
| `cdk/OpenAPI_Swagger_Definition.yaml` | MODIFY | Add generate_topics endpoint |
| `cdk/lambda/initializer/initializer.js` | MODIFY | Add schema migration SQL |
| `frontend/src/pages/instructor/InstructorEditCourse.jsx` | MODIFY | Add button + display |
| `frontend/src/pages/instructor/InstructorNewModule.jsx` | MODIFY | Add button + display |
