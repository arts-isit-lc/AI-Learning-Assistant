# Requirements Document

## Introduction

This feature adds the ability for students to view uploaded course material PDFs side-by-side with the chatbot conversation. Currently, instructors upload PDFs to S3 and those documents are processed into vector embeddings for RAG retrieval, but the student never sees the original document. This feature gives students direct access to view the source materials within the chat interface — enabling them to read along while conversing with the AI assistant.

The feature introduces a toggleable PDF viewer panel in the student chat view, a file list showing all documents available for the current module, and the backend infrastructure to securely serve PDFs to enrolled students via pre-signed URLs.

## Glossary

- **PDF_Panel**: A collapsible right-side panel in the student chat view that displays a rendered PDF document alongside the conversation.
- **File_List_Popover**: A popover menu triggered by a button that shows all available documents for the current module, allowing the student to select one to view.
- **Read_PreSigned_URL**: A time-limited S3 GET pre-signed URL that allows a student to download/view a specific PDF without direct S3 access.
- **Module_Files**: The PostgreSQL table storing metadata about uploaded documents (file_id, module_id, filename, filetype, filepath, s3_bucket_reference).
- **Data_Ingestion_Bucket**: The S3 bucket where instructor-uploaded course materials are stored at the path `{course_id}/{module_id}/documents/{filename}.{filetype}`.
- **Enrolled_Student**: A student with an active record in the Enrolments table for the course associated with the module.
- **StudentFunction**: The existing Lambda function (`studentFunction`) that handles student API requests, running under `dbLambdaRole`.
- **Authorizer_Context**: The identity information injected by the `studentAuthorizer` Lambda into `event.requestContext.authorizer`, including the student's email.

## Requirements

### Requirement 1: Student File List Endpoint

**User Story:** As a Student, I want to see a list of all documents uploaded for the current module, so that I can choose which course material to view while chatting with the AI assistant.

#### Acceptance Criteria

1. THE StudentFunction SHALL expose a new API path `GET /student/files` that accepts `course_id` and `module_id` as query string parameters.
2. THE endpoint SHALL extract the student's identity exclusively from the Authorizer_Context (`event.requestContext.authorizer.email`) — no email parameter in the query string.
3. WHEN the endpoint receives a valid request, THE StudentFunction SHALL query the Module_Files table for all records matching the provided `module_id` and return the results as a JSON array.
4. THE response SHALL include for each file: `file_id`, `filename`, `filetype`, and `time_uploaded`.
5. WHEN the student is not enrolled in the course associated with the provided `module_id`, THE endpoint SHALL return a 403 Forbidden response.
6. WHEN the `module_id` has no uploaded files, THE endpoint SHALL return an empty JSON array with a 200 status code.
7. THE endpoint SHALL be protected by the existing API Gateway `studentAuthorizer`.

### Requirement 2: Student Document URL Endpoint

**User Story:** As a Student, I want to get a secure, temporary URL to view a specific PDF, so that I can read the document without needing direct S3 access.

#### Acceptance Criteria

1. THE StudentFunction SHALL expose a new API path `GET /student/file_url` that accepts `file_id` as a query string parameter.
2. THE endpoint SHALL extract the student's identity exclusively from the Authorizer_Context — no email parameter in the query string.
3. WHEN the endpoint receives a valid request, THE StudentFunction SHALL look up the file record by `file_id` and generate a Read_PreSigned_URL using the stored `filepath` column as the S3 key, with a TTL of 1 hour.
4. THE response SHALL return the pre-signed URL in the format `{ "presignedurl": "<url>" }` with a 200 status code.
5. WHEN the student is not enrolled in the course that owns the file's module, THE endpoint SHALL return a 403 Forbidden response.
6. WHEN the requested `file_id` does not exist in the Module_Files table, THE endpoint SHALL return a 404 Not Found response.
7. THE endpoint SHALL be protected by the existing API Gateway `studentAuthorizer`.
8. THE endpoint SHALL use the stored `filepath` column from Module_Files as the S3 key — it SHALL NOT reconstruct the key from separate parameters.

### Requirement 3: IAM Permissions for Student S3 Read Access

**User Story:** As a system operator, I want the student Lambda role to have read access to the data ingestion bucket, so that it can generate read pre-signed URLs for students without over-permissioning.

#### Acceptance Criteria

1. THE CDK_Stack SHALL add an `s3:GetObject` permission to the `dbLambdaRole` scoped to the Data_Ingestion_Bucket ARN with a `/*` suffix.
2. THE CDK_Stack SHALL NOT add any other S3 permissions (no `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`) to the `dbLambdaRole` for this bucket.
3. THE IAM permission SHALL be tested in `cdk/test/iam-policies.test.ts` to verify the scoped resource ARN.
4. THE CDK_Stack SHALL add `BUCKET` and `REGION` environment variables to the `studentFunction` Lambda.

### Requirement 4: File List UI in Student Chat

**User Story:** As a Student, I want a button in the chat interface that shows me all available course documents, so that I can quickly find and open materials while studying.

#### Acceptance Criteria

1. THE student chat view SHALL display a "View Materials" button in the chat header area.
2. WHEN the student clicks the "View Materials" button, THE UI SHALL fetch the file list from the backend (lazy loading — not on module mount).
3. AFTER the file list is fetched, THE UI SHALL display a File_List_Popover containing all files for the current module.
4. THE File_List_Popover SHALL display each file's name and type.
5. WHEN the student clicks a file in the File_List_Popover, THE UI SHALL open the PDF_Panel displaying that file and close the popover.
6. WHEN the file list is loading, THE File_List_Popover SHALL display a loading skeleton placeholder.
7. WHEN there are no files for the module, THE File_List_Popover SHALL display a "No materials available" message.
8. WHEN the file list has been previously fetched, THE UI SHALL use the cached list on subsequent popover opens without re-fetching.

### Requirement 5: PDF Viewer Panel

**User Story:** As a Student, I want to view a PDF document side-by-side with the chat conversation, so that I can reference course materials while asking questions.

#### Acceptance Criteria

1. WHEN the student selects a file from the File_List_Popover, THE UI SHALL render a PDF_Panel on the right side of the chat area, reducing the chat width proportionally.
2. THE layout with the PDF_Panel open SHALL be approximately: Sessions (1/5) | Chat (2/5) | PDF Viewer (2/5).
3. THE PDF_Panel SHALL render the PDF using a client-side PDF rendering library (react-pdf) fetching the document from the Read_PreSigned_URL.
4. THE PDF_Panel SHALL include page navigation controls: previous page, next page, and current page number / total pages display.
5. THE PDF_Panel SHALL include a close button that dismisses the panel and restores the chat to full width.
6. THE PDF_Panel SHALL include a header displaying the current file name and a file-switch control (button or dropdown) to select a different file without closing the panel.
7. WHEN the PDF is loading, THE PDF_Panel SHALL display a loading skeleton placeholder.
8. WHEN the PDF fails to load (e.g., expired URL, network error), THE PDF_Panel SHALL display an error state with a "Retry" button that fetches a fresh pre-signed URL and reloads.
9. THE PDF_Panel SHALL support zoom in/out controls with a minimum of 50% and maximum of 200% zoom.

### Requirement 6: Responsive Behavior

**User Story:** As a Student on a smaller screen, I want the PDF viewer to adapt gracefully, so that I can still use both the chat and the viewer without the interface becoming unusable.

#### Acceptance Criteria

1. WHEN the viewport width is below the `md` breakpoint (768px), THE PDF_Panel SHALL render as a full-screen overlay with a back button instead of a side panel.
2. WHEN the PDF_Panel is in full-screen overlay mode, THE chat conversation SHALL be hidden behind the overlay.
3. THE File_List_Popover SHALL remain functional at all viewport sizes.

### Requirement 7: Enrolment Verification

**User Story:** As a system operator, I want document access to be restricted to enrolled students only, so that unenrolled users cannot access course materials.

#### Acceptance Criteria

1. WHEN the student file list or document URL endpoint is called, THE StudentFunction SHALL verify the requesting student has an active enrolment for the course that owns the requested module.
2. THE enrolment check SHALL query the Enrolments table joining through Course_Concepts and Course_Modules to verify the module belongs to a course the student is enrolled in, preventing mixed-parameter attacks where `course_id` and `module_id` belong to different courses.
3. WHEN enrolment verification fails, THE endpoint SHALL return a 403 status code with a message indicating insufficient access.
4. THE enrolment verification logic SHALL be implemented as a shared helper function (`verifyStudentAccess`) to ensure consistency between endpoints.
