# Implementation Plan: Upload Progress Feedback

## Overview

This plan implements real-time upload progress feedback for the instructor file management UI. The implementation spans backend infrastructure (DB migration, CDK changes, Lambda modifications), a new batch status endpoint, frontend hooks for XHR upload and polling, and UI components for progress display and save-button gating. Each task builds incrementally — backend first to unblock frontend polling, then hooks, then UI wiring.

## Tasks

- [x] 1. Backend infrastructure and database migration
  - [x] 1.1 Add UNIQUE constraint migration to initializer Lambda
    - Add `CREATE UNIQUE INDEX IF NOT EXISTS idx_module_files_unique_file ON "Module_Files" (module_id, filename, filetype);` to the initializer Lambda's schema migration section in `cdk/lambda/initializer/initializer.py`
    - This enables the upsert logic in the generatePreSignedURL Lambda
    - _Requirements: 9.3_

  - [x] 1.2 Modify generatePreSignedURL Lambda to create DB record and return file_id
    - Add DB connection via RDS Proxy (psycopg2, `sslmode=require`) using SecretsManager credentials
    - Add upsert logic: INSERT or UPDATE `Module_Files` with `processing_status='pending'`, RETURNING `file_id`
    - Return `{ "presignedurl": "...", "file_id": "uuid" }` in response body
    - Add Powertools Logger with `service="generate-presigned-url"` and `@logger.inject_lambda_context` decorator per lambda-coding-standards
    - Add environment variables: `SM_DB_CREDENTIALS`, `RDS_PROXY_ENDPOINT`
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 1.3 Update CDK stack for generatePreSignedURL Lambda (VPC, IAM, env vars)
    - Add VPC config (security group, subnets) to the generatePreSignedURL Lambda in `cdk/lib/api-gateway-stack.ts`
    - Add SecretsManager permission scoped to `secretPathUser` ARN
    - Add EC2 VPC networking permissions (`ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface`) with resource `'*'`
    - Add environment variables `SM_DB_CREDENTIALS` and `RDS_PROXY_ENDPOINT`
    - _Requirements: 9.1_

  - [x] 1.4 Add batch file processing status route to instructorFunction Lambda
    - Add `case "GET /instructor/file_processing_statuses":` to the switch statement in `cdk/lambda/lib/instructorFunction.js`
    - Validate `module_id` query parameter is present and a valid UUID (regex)
    - Query `SELECT file_id, filename, processing_status, chunk_count, last_processed_at FROM "Module_Files" WHERE module_id = $1`
    - Return `{ files: [...] }` JSON response
    - Return HTTP 400 with descriptive error if `module_id` is missing or invalid UUID
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 1.5 Add API Gateway route for file_processing_statuses endpoint
    - Add `GET /instructor/file_processing_statuses` resource and method to `cdk/OpenAPI_Swagger_Definition.yaml`
    - Wire to instructorFunction Lambda via aws_proxy integration
    - Use the existing instructor authorizer for authentication
    - Add CORS OPTIONS method
    - _Requirements: 4.4_

- [x] 2. Checkpoint - Backend verification
  - Ensure all CDK changes compile (`npx tsc --noEmit` in cdk/)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Frontend constants and utility setup
  - [x] 3.1 Create upload configuration constants file
    - Create `frontend/src/constants/uploadConfig.js`
    - Export: `POLLING_INTERVAL_MS = 3000`, `POLLING_TIMEOUT_SECONDS = 300`, `XHR_UPLOAD_TIMEOUT_MS = 300000`, `NOT_FOUND_GRACE_PERIOD_MS = 30000`, `NOT_FOUND_WARNING_THRESHOLD_MS = 60000`
    - _Requirements: 2.4, 3.8, 3.9_

  - [x] 3.2 Add shadcn/ui Progress component
    - Create `frontend/src/components/ui/progress.jsx` using the shadcn/ui Progress primitive
    - Support both determinate (value prop) and indeterminate (no value / `indeterminate` class) variants
    - Use semantic colour tokens: `bg-primary` for progress fill, `bg-secondary` for track
    - _Requirements: 6.1, 6.2_

- [x] 4. Frontend hooks implementation
  - [x] 4.1 Implement useFileUpload hook
    - Create `frontend/src/hooks/useFileUpload.js`
    - Implement XHR-based upload with `upload.onprogress` listener computing `(loaded / total) * 100`
    - Call `apiClient.get('instructor/generate_presigned_url', {...})` to obtain presigned URL + file_id before upload
    - Track per-file state: `{ fileId, fileName, status, progress, error, xhr, uploadStartedAt }`
    - Use `useReducer` for complex state transitions (uploading, upload_failed)
    - Expose: `uploadFiles(files, courseId, moduleId, moduleName)`, `abortFile(fileId)`, `retryFile(fileId)`, `removeFile(fileId)`, `fileStates`
    - Set XHR timeout to `XHR_UPLOAD_TIMEOUT_MS` (300s)
    - On abort: call `xhr.abort()` and remove from state
    - On success: resolve with file_id for polling handoff
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 7.1, 7.4, 7.5_

  - [ ]* 4.2 Write property test for useFileUpload save gate logic (Property 2)
    - **Property 2: Save button disabled while tracked files incomplete**
    - Test that `isSaveDisabled === trackedFiles.some(f => BLOCKING_STATUSES.includes(f.status))` for any random set of file statuses
    - Use fast-check to generate random combinations of file statuses
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6, 5.7**

  - [x] 4.3 Implement useProcessingPoller hook
    - Create `frontend/src/hooks/useProcessingPoller.js`
    - Poll `GET /instructor/file_processing_statuses?module_id=<uuid>` every 3 seconds using `setInterval`
    - Track per-file state: `{ fileId, status, chunkCount, lastProcessedAt, uploadCompletedAt, pollingStartedAt }`
    - Derive `not_found` locally when a tracked file_id is absent from response
    - Derive `timed_out` when POLLING_TIMEOUT_SECONDS (300s) elapsed without `complete`/`failed`
    - Stop polling when all tracked files are `complete`, `failed`, or removed
    - Continue including `timed_out` and `not_found` files in polling
    - On page load: issue initial fetch and add files with `pending`/`processing` to tracked set
    - Expose: `processingStates`, `addTrackedFiles(fileIds)`, `removeTrackedFile(fileId)`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 8.1, 8.2, 8.3, 8.4_

  - [ ]* 4.4 Write property test for polling termination logic (Property 5)
    - **Property 5: Polling stops only when all tracked files terminal**
    - Test that polling is active iff at least one file has status in `{ pending, processing, not_found, timed_out }`
    - Use fast-check to generate random file status sequences
    - **Validates: Requirements 3.6, 3.7**

- [x] 5. Frontend UI components
  - [x] 5.1 Implement FileProgressRow component
    - Create `frontend/src/components/FileProgressRow.jsx`
    - Render based on status: determinate Progress (uploading), indeterminate Progress (pending/processing), success icon (complete), error icon (failed/upload_failed), warning (not_found/timed_out)
    - Use lucide-react icons: `CheckCircle2` (success), `AlertCircle` (error), `Clock` (timeout), `X` (abort/remove), `RotateCcw` (retry)
    - Include abort button during upload, retry/remove buttons on failure
    - Show timing-based messages for `not_found`: "Waiting for processing..." (< 30s), warning text (> 60s)
    - Follow 4pt grid spacing, semantic colour tokens (`bg-primary`, `bg-destructive`, `text-muted-foreground`)
    - Wrap icon-only buttons with `Tooltip` and `aria-label` per accessibility rules
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.5, 7.6_

  - [ ]* 5.2 Write property test for file removal re-enabling save (Property 3)
    - **Property 3: File removal re-enables save when no remaining blockers**
    - Test that removing all files with blocking statuses results in save being enabled
    - Use fast-check to generate random tracked file sets and random removal operations
    - **Validates: Requirements 7.3, 7.7**

  - [x] 5.3 Refactor FileManagement component to integrate progress UI
    - Modify `frontend/src/components/FileManagement.jsx`
    - Replace MUI imports with shadcn/ui equivalents and Tailwind classes (per frontend-conventions: no MUI)
    - Add a Status column to the file table for new/tracked files
    - Render `FileProgressRow` for files that have upload or processing state
    - Accept new props: `uploadStates`, `processingStates`, `onRetryFile`, `onRemoveFile`, `onAbortFile`
    - Show progress UI only for tracked files; already-complete files display normally
    - _Requirements: 6.5, 7.2, 7.5, 7.6_

- [x] 6. Integration wiring and save gate
  - [x] 6.1 Integrate hooks and save gate into InstructorEditCourse page
    - Modify `frontend/src/pages/instructor/InstructorEditCourse.jsx`
    - Replace existing `uploadFiles` function with `useFileUpload` hook
    - Add `useProcessingPoller` hook with `moduleId` and tracked file IDs
    - Implement save gate logic: disable Save button when any tracked file has status in `{ uploading, upload_failed, pending, processing, not_found, timed_out, failed }`
    - Add tooltip on disabled Save button: "Files are still processing..."
    - On upload complete: hand off file_ids to processing poller via `addTrackedFiles`
    - On page load: fetch initial statuses and resume polling for `pending`/`processing` files
    - Pass upload/processing states and handlers down to FileManagement component
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 8.1, 8.2, 8.3, 8.4_

  - [x] 6.2 Integrate hooks into InstructorNewModule page
    - Modify `frontend/src/pages/instructor/InstructorNewModule.jsx`
    - Apply the same `useFileUpload` + `useProcessingPoller` pattern as InstructorEditCourse
    - Wire save gate logic and progress UI
    - Note: New modules won't have existing files to poll on load, but should still track new uploads
    - _Requirements: 5.1, 5.2, 5.3, 5.7_

  - [ ]* 6.3 Write unit tests for batch endpoint handler (Property 8)
    - **Property 8: Invalid module_id returns 400**
    - Test that requests with missing or non-UUID `module_id` return HTTP 400
    - Test that valid UUID returns file array (even if empty)
    - Use fast-check to generate random strings (valid UUIDs + garbage)
    - **Validates: Requirements 4.3**

- [x] 7. Final checkpoint - Ensure all changes compile and lint
  - Run `npx tsc --noEmit` in `cdk/` to verify CDK TypeScript compiles
  - Run `npm run lint` in `frontend/` to verify ESLint passes
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The existing `FileManagement.jsx` uses MUI — task 5.3 migrates it to Tailwind/shadcn per frontend-conventions
- The `generatePreSignedURL` Lambda currently has no VPC or DB access — task 1.3 adds this infrastructure
- Property tests use fast-check and target pure logic (save gate, polling termination, UUID validation)
- The instructorFunction Lambda already has DB access via `lib.js` — the new route reuses this connection
- Checkpoints ensure incremental validation between backend and frontend phases

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "3.1", "3.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5", "4.1", "4.3"] },
    { "id": 3, "tasks": ["4.2", "4.4", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3"] },
    { "id": 5, "tasks": ["6.1", "6.2"] },
    { "id": 6, "tasks": ["6.3"] }
  ]
}
```
