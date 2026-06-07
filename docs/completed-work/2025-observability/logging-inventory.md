# Logging Inventory

This document catalogs all logging across the AILA application — what each Lambda function logs, the framework it uses, the log levels, and the correlation keys available for querying.

## Logging Frameworks

| Framework | Used By | Output Format |
|-----------|---------|---------------|
| AWS Lambda Powertools Logger | Python handlers (container + zip) | Structured JSON |
| Python `logging` module | Python helper modules (chat.py, vectorstore.py, helper.py, documents.py) | Plain text (inherits Powertools format when called from handler context) |
| `console.log` / `console.error` | All Node.js handlers | Plain text |
| `print()` | initializer.py only | Plain text |

## Service Names (Powertools)

| Service Name | Lambda Function | CloudWatch Log Group |
|-------------|----------------|---------------------|
| `text-generation` | TextGenLambdaDockerFunc | `/aws/lambda/AILA-ApiGatewayStack-TextGenLambdaDockerFunc` |
| `data-ingestion` | DataIngestLambdaDockerFunc | `/aws/lambda/AILA-ApiGatewayStack-DataIngestLambdaDockerFunc` |
| `sqs-trigger` | SQSTriggerDockerFunc | `/aws/lambda/AILA-ApiGatewayStack-SQSTriggerDockerFunc` |
| `delete-last-message` | DeleteLastMessage | `/aws/lambda/AILA-ApiGatewayStack-DeleteLastMessage` |
| `event-notification` | NotificationFunction | `/aws/lambda/AILA-ApiGatewayStack-NotificationFunction` |
| (default) | GeneratePreSignedURLFunc | `/aws/lambda/AILA-ApiGatewayStack-GeneratePreSignedURLFunc` |
| (default) | GetFilesFunction | `/aws/lambda/AILA-ApiGatewayStack-GetFilesFunction` |
| (default) | GetChatLogsFunction | `/aws/lambda/AILA-ApiGatewayStack-GetChatLogsFunction` |
| (default) | DeleteFileFunc | `/aws/lambda/AILA-ApiGatewayStack-DeleteFileFunc` |
| (default) | DeleteModuleFunc | `/aws/lambda/AILA-ApiGatewayStack-DeleteModuleFunc` |

## Correlation Keys

These keys are appended to structured log entries for request-scoped tracing:

| Key | Appended By | Purpose |
|-----|------------|---------|
| `session_id` | text-generation, delete-last-message | Correlate logs for a single chat session |
| `course_id` | text-generation, sqs-trigger | Correlate logs for a specific course |
| `request_id` | sqs-trigger | Correlate logs for a chat log export job |

All Powertools-instrumented handlers also automatically include `xray_trace_id` and `correlation_id` from the X-Ray trace context.

## Structured Log Schema (Powertools Handlers)

Every log entry from a Powertools-instrumented handler contains:

```json
{
  "level": "INFO",
  "location": "handler:42",
  "message": "Processing request",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "text-generation",
  "function_name": "AILA-TextGenLambdaDockerFunc",
  "function_memory_size": 1024,
  "function_arn": "arn:aws:lambda:...",
  "cold_start": true,
  "xray_trace_id": "1-abc123-def456",
  "session_id": "uuid-session",
  "course_id": "uuid-course"
}
```

---

## Per-Function Log Details

### TextGenLambdaDockerFunc (text-generation)

**Framework**: Powertools Logger | **Decorator**: `@logger.inject_lambda_context(clear_state=True)`

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Text Generation Lambda function is called!" | — |
| INFO | "TIMING: initialize_constants took {ms}ms" | Performance |
| INFO | "TIMING: get_module_context took {ms}ms" | Performance |
| INFO | "TIMING: get_allowed_file_ids took {ms}ms" | Performance |
| INFO | "TIMING: get_vectorstore_retriever took {ms}ms" | Performance |
| INFO | "TIMING: get_response_streaming took {ms}ms" | Performance |
| INFO | "TIMING: total handler time {ms}ms" | Performance |
| INFO | "Module context fetched: module_name=..., has_system_prompt=..., llm_model_id=..." | Request context |
| INFO | "Using LLM model ID: {id} for course {course_id}" | Model selection |
| INFO | "Start of conversation. Creating conversation history table in DynamoDB." | Session lifecycle |
| INFO | "Processing student question: {question}" | User input |
| INFO | "Connected to the database!" | Infrastructure |
| INFO | "Creating Bedrock LLM instance." | Infrastructure |
| INFO | "Retrieving vectorstore config." | Infrastructure |
| INFO | "Creating history-aware retriever." | Infrastructure |
| INFO | "Generating response from the LLM." | Processing |
| INFO | "Returning the generated response." | Response |
| WARNING | "aws-xray-sdk not available, skipping X-Ray patching" | X-Ray init |
| WARNING | "X-Ray SDK patching failed: {exc}" | X-Ray init |
| WARNING | "Invalid LLM model ID '{id}' for course {course_id}, using system default" | Validation |
| WARNING | "No context found for course_id=..., module_id=..." | Data missing |
| WARNING | "Failed to send chat chunk to AppSync: {e}" | Streaming |
| ERROR | "Missing required parameter: course_id/session_id/module_id" | Validation |
| ERROR | "Error fetching context for course_id=..., module_id=..." | DB query |
| ERROR | "No system prompt found for course_id: {course_id}" | Data missing |
| ERROR | "Error getting LLM from Bedrock: {e}" | Bedrock |
| ERROR | "Error retrieving vectorstore config: {e}" | DB/secrets |
| ERROR | "Error creating history-aware retriever: {e}" | RAG pipeline |
| ERROR | "No database connection available." | Infrastructure |
| ERROR | "Error getting response: {e}" | LLM response |
| ERROR | "Failed to decode JSON for secret: {e}" | Secrets Manager |
| ERROR | "Error fetching secret: {e}" | Secrets Manager |
| ERROR | "Error fetching parameter {param_name}: {e}" | SSM |
| ERROR | "Failed to connect to database: {e}" | RDS |
| ERROR | "Error fetching module context: {e}" | DB query |
| ERROR | "Error fetching allowed_file_ids: {e}" | DB query |

**Helper modules** (chat.py, vectorstore.py) use Python `logging` module — their output inherits the Powertools format when called within the handler context:

| Level | Message | Source |
|-------|---------|--------|
| INFO | "ARCH-2: Using LLM reformulation for query" | vectorstore.py |
| INFO | "ARCH-2: Skipping LLM reformulation — query appears standalone" | vectorstore.py |
| INFO | "TIMING: first token arrived at {ms}ms" | chat.py |
| ERROR | "Error in hybrid_search: {e}" | vectorstore.py |
| ERROR | "Error during streaming: {e}" | chat.py |
| ERROR | "Error fetching other module names: {e}" | chat.py |


### DataIngestLambdaDockerFunc (data-ingestion)

**Framework**: Powertools Logger | **Decorator**: `@logger.inject_lambda_context(clear_state=True)`

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Connected to the database!" | Infrastructure |
| INFO | "file_key: {file_key}" | S3 event |
| INFO | "Ignoring event from non-target bucket: {bucket_name}" | S3 filtering |
| INFO | "Successfully updated file {name}.{type} in database for module {id}." | DB write |
| INFO | "Successfully inserted file {name}.{type} into database for module {id}." | DB write |
| INFO | "File {name}.{type} inserted successfully." | Handler flow |
| INFO | "File {name}.{type} is being deleted." | Handler flow |
| INFO | "Vectorstore updated successfully for module {id} in course {id}." | Vectorstore |
| WARNING | "aws-xray-sdk not available, skipping X-Ray patching" | X-Ray init |
| WARNING | "X-Ray SDK patching failed: {exc}" | X-Ray init |
| ERROR | "Error fetching secret: {e}" | Secrets Manager |
| ERROR | "Error fetching parameter {param}: {e}" | SSM |
| ERROR | "Failed to connect to database: {e}" | RDS |
| ERROR | "Error parsing S3 file path: {e}" | Input parsing |
| ERROR | "No database connection available." | Infrastructure |
| ERROR | "Error inserting file {name}.{type} into database: {e}" | DB write |
| ERROR | "Error fetching file_id: {e}" | DB query |
| ERROR | "Error updating vectorstore for module {id} in course {id}: {e}" | Vectorstore |

**Helper modules** (helper.py, documents.py) use Python `logging` module:

| Level | Message | Source |
|-------|---------|--------|
| INFO | "Initializing the VectorStore" | helper.py |
| INFO | "VectorStore initialized" | helper.py |
| INFO | "OCR used for page {num} of {filename}" | documents.py |
| INFO | "output_bucket: {bucket}" | documents.py |
| INFO | "Deleting {filename} from {bucket}" | documents.py |
| INFO | "Indexing updates: {idx}" | documents.py |
| INFO | "No documents found for indexing." | documents.py |
| WARNING | "OCR failed on page {num} of {filename}: {e}" | documents.py |
| WARNING | "Empty chunk for {filename}" | documents.py |
| ERROR | "Error initializing vector store: {e}" | helper.py |

### SQSTriggerDockerFunc (sqs-trigger)

**Framework**: Powertools Logger | **Decorator**: `@logger.inject_lambda_context(clear_state=True)`

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Connected to the database!" | Infrastructure |
| INFO | "Fetched {count} chat log records for course_id: {id}." | DB query |
| INFO | "CSV file created successfully: {path}" | File I/O |
| INFO | "File uploaded successfully to S3: s3://{bucket}/{key}" | S3 upload |
| INFO | "Completion status updated for course_id: ..., instructor_email: ..., request_id: ..." | DB write |
| INFO | "Retrieved chat logs" | Handler flow |
| INFO | "Generated CSV file" | Handler flow |
| INFO | "Uploaded to S3: {uri}" | Handler flow |
| INFO | "Updated completion status" | Handler flow |
| INFO | "Sent notification successfully" | Handler flow |
| INFO | "RESPONSE: {response}" | AppSync response |
| INFO | "Notification sent successfully: {data}" | AppSync |
| WARNING | "aws-xray-sdk not available, skipping X-Ray patching" | X-Ray init |
| WARNING | "X-Ray SDK patching failed: {exc}" | X-Ray init |
| ERROR | "Invalid event format: missing 'Records'." | Validation |
| ERROR | "Missing required parameters: course_id or instructor_email or request_id." | Validation |
| ERROR | "Database connection is unavailable." | Infrastructure |
| ERROR | "Error fetching DB secret: {e}" | Secrets Manager |
| ERROR | "Failed to connect to database: {e}" | RDS |
| ERROR | "Error querying chat logs for course_id {id}: {e}" | DB query |
| ERROR | "Error writing to CSV file {name}: {e}" | File I/O |
| ERROR | "Error uploading file to S3: {e}" | S3 |
| ERROR | "Error updating completion status..." | DB write |
| ERROR | "Failed to send notification to AppSync: {data}" | AppSync |
| ERROR | "Error invoking AppSync notification: {e}" | AppSync |
| ERROR | "Error processing SQS message: {e}" | Handler |
| ERROR | "Unhandled error in sqsTrigger handler: {e}" | Handler |

### DeleteLastMessage (delete-last-message)

**Framework**: Powertools Logger | **Decorator**: `@logger.inject_lambda_context(clear_state=True)`

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Connected to the database!" | Infrastructure |
| INFO | "Not enough messages to delete for session_id: {id}" | Business logic |
| INFO | "Successfully deleted the last two messages for session_id: {id}" | DB write |
| INFO | "Not enough messages to delete." | DynamoDB check |
| INFO | "Successfully deleted the last human and AI messages in DynamoDB for session_id: {id}" | DynamoDB write |
| INFO | "Successfully deleted the last human and AI messages in RDS for session_id: {id}" | DB write |
| ERROR | "Missing required parameter: session_id" | Validation |
| ERROR | "Failed to decode JSON for secret: {e}" | Secrets Manager |
| ERROR | "Error fetching secret: {e}" | Secrets Manager |
| ERROR | "Error fetching parameter {param}: {e}" | SSM |
| ERROR | "Failed to connect to database: {e}" | RDS |
| ERROR | "No database connection available." | Infrastructure |
| ERROR | "Error deleting messages from database: {e}" | DB write |
| ERROR | "No conversation history found for session_id: {id}" | DynamoDB |
| ERROR | "Failed to delete the last human and AI messages in RDS for session_id: {id}" | DB write |
| ERROR | "Error deleting last message: {e}" | Handler |

### NotificationFunction (event-notification)

**Framework**: Powertools Logger | **Decorator**: `@logger.inject_lambda_context(clear_state=True)`

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Event received" | extra: `{event}` |
| INFO | "Extracted arguments" | extra: `{request_id, message}` |
| ERROR (exception) | "Error processing event notification" | Full stack trace |

### GeneratePreSignedURLFunc

**Framework**: Powertools Logger | **Decorator**: `@logger.inject_lambda_context(log_event=True)`

| Level | Message | Context |
|-------|---------|---------|
| INFO | `{course_id, module_id, file_type, file_name}` | Request params |
| ERROR | "Error generating presigned URL or uploading txt file: {e}" | S3 |

### DeleteFileFunc

**Framework**: Powertools Logger

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Connected to the database!" | Infrastructure |
| INFO | "Successfully deleted file {name}.{type} for module {id}." | DB write |
| INFO | "S3 Response: {response}" | S3 delete |
| INFO | "File {name}.{type} and any associated files deleted successfully from S3." | S3 |
| ERROR | "Missing required parameters" | extra: `{course_id, module_id, file_name, file_type}` |
| ERROR | "No database connection available." | Infrastructure |
| ERROR | "Failed to connect to database: {e}" | RDS |
| ERROR | "Error deleting file {name}.{type} from database: {e}" | DB write |
| ERROR (exception) | "Error deleting file: {e}" | Handler |

### DeleteModuleFunc

**Framework**: Powertools Logger

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Deleted objects: {response}" | S3 batch delete |
| INFO | "No objects found in module directory: {prefix}" | S3 |
| ERROR | "Missing required parameters" | extra: `{course_id, module_id}` |
| ERROR (exception) | "Error deleting module directory: {e}" | Handler |

### GetFilesFunction

**Framework**: Powertools Logger

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Connected to the database!" | Infrastructure |
| INFO | "Presigned URLs and metadata generated successfully" | extra: `{course_id, module_id, file_count}` |
| WARNING | "No metadata found for {name}.{type} in module {id}" | DB query |
| ERROR | "Missing required parameters" | extra: `{course_id, module_id}` |
| ERROR | "Failed to decode JSON for secret: {e}" | Secrets Manager |
| ERROR | "Error fetching secret: {e}" | Secrets Manager |
| ERROR | "Failed to connect to database: {e}" | RDS |
| ERROR | "Error retrieving metadata for {name}.{type}: {e}" | DB query |
| ERROR (exception) | "Error generating presigned URLs or retrieving metadata: {e}" | Handler |

### GetChatLogsFunction

**Framework**: Powertools Logger

| Level | Message | Context |
|-------|---------|---------|
| INFO | "Presigned URLs generated successfully" | extra: `{course_id, instructor_email, file_count}` |
| ERROR | "Missing required parameters" | extra: `{course_id, instructor_email}` |
| ERROR (exception) | "Error generating presigned URLs for chat logs: {e}" | Handler |

---

## Node.js Handlers (console.log / console.error)

These handlers use unstructured logging. Output appears as plain text in CloudWatch.

### studentFunction

| Level | Message | Context |
|-------|---------|---------|
| log | "message", message_content | Chat message |
| log | "session", sessionId | Session ID |
| log | "email", studentEmail | User email |
| log | "course", courseId | Course ID |
| log | "module", moduleId | Module ID |
| log | "AI message", message_content | AI response |
| error | err | Various error handlers |

### instructorFunction

| Level | Message | Context |
|-------|---------|---------|
| log | "CREATE MODULE - module_prompt: {prompt}" | Module creation |
| log | "CREATE MODULE - event.body: {body}" | Request body |
| log | "EDIT MODULE - module_prompt: {prompt}" | Module edit |
| log | "EDIT MODULE - event.body: {body}" | Request body |
| error | err | Various error handlers |

### adminFunction

| Level | Message | Context |
|-------|---------|---------|
| log | enrolment_id, modulesResult, studentModuleInsertions | Enrolment flow |
| log | "course creation start" | Course creation |
| log | newCourse | Course data |
| log | response | Final response |
| log | err | Various error handlers |

### sqsFunction

| Level | Message | Context |
|-------|---------|---------|
| log | "Parsing instructor_email, course_id, and request_id" | Input parsing |
| log | "Inserting record into the chatlogs_notifications table with completion status FALSE" | DB write |
| log | "Sending message to SQS" | SQS |
| log | "Message sent to SQS" | SQS |
| error | "Error processing SQS function: {error}" | Handler |

### adjustUserRoles

| Level | Message | Context |
|-------|---------|---------|
| log | "DB roles updated to include admin" | Role sync |
| log | "DB roles updated to match Cognito ({role})" | Role sync |
| log | "Cognito roles updated to match DB ({role})" | Role sync |
| error | err | Error handler |

### addStudentOnSignUp

| Level | Message | Context |
|-------|---------|---------|
| error | "Error assigning user to group: {err}" | Cognito |

### preSignup

| Level | Message | Context |
|-------|---------|---------|
| error | error | Domain validation failure |

### Authorizer Functions (admin, student, instructor)

| Level | Message | Context |
|-------|---------|---------|
| error | "Error initializing JWT verifier: {error}" | Cold start |
| error | "Authorization error: {error}" | Auth failure |
| log | "event", event | studentAuthorizer only |

### lib.js / libadmin.js (shared DB connection)

| Level | Message | Context |
|-------|---------|---------|
| log | "Database connection initialized" | Cold start |
| error | "Error initializing database connection: {error}" | Cold start |

### appsync.js

No logging statements.

### initializer.py

Uses `print()` only — outputs psycopg2 version, connection object, and table contents during database initialization. This is a one-time setup Lambda, not invoked during normal operation.

---

## CloudWatch Insights Queries

### Find all errors across Powertools-instrumented functions

```
fields @timestamp, service, level, message
| filter level = "ERROR"
| sort @timestamp desc
| limit 100
```

### Trace a specific chat session

```
fields @timestamp, service, level, message
| filter session_id = "your-session-id-here"
| sort @timestamp asc
```

### Performance timing for text generation

```
fields @timestamp, message
| filter service = "text-generation" and message like /TIMING/
| sort @timestamp desc
| limit 50
```

### Find all X-Ray patching issues

```
fields @timestamp, service, level, message
| filter message like /xray/i or message like /X-Ray/
| sort @timestamp desc
```

### Track a chat log export job

```
fields @timestamp, service, level, message
| filter service = "sqs-trigger" and course_id = "your-course-id"
| sort @timestamp asc
```
