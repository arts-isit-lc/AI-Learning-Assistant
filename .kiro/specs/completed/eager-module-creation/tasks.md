# Implementation Plan: Eager Module Creation

## Overview

This plan implements the eager module creation flow — reserving a `module_id` at page load so file uploads can begin immediately on the New Module page. The implementation spans: database schema migration, three new backend routes (reserve, finalize, cleanup), API Gateway routing, student view isolation, data ingestion guards, a frontend `useDraftModule` hook with page refactoring, and a scheduled orphan cleanup Lambda.

## Tasks

- [x] 1. Database schema migration
  - [x] 1.1 Add status column, timestamps, nullable concept_id, and partial index to Course_Modules
    - Modify `cdk/lambda/initializer/initializer.py` to add the following migration statements:
    - `ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'active';`
    - `ALTER TABLE "Course_Modules" ADD CONSTRAINT chk_course_modules_status CHECK (status IN ('draft', 'active', 'deleting'));`
    - `ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`
    - `ALTER TABLE "Course_Modules" ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`
    - `ALTER TABLE "Course_Modules" ALTER COLUMN concept_id DROP NOT NULL;`
    - `CREATE INDEX IF NOT EXISTS idx_course_modules_status_created ON "Course_Modules" (status, created_at) WHERE status IN ('draft', 'deleting');`
    - Ensure existing records default to `status = 'active'` via the column DEFAULT
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 2. Backend routes — reserve, finalize, cleanup
  - [x] 2.1 Implement POST /instructor/reserve_module route in instructorFunction.js
    - Add `case "POST /instructor/reserve_module":` to the switch statement in `cdk/lambda/lib/instructorFunction.js`
    - Validate required query params: `course_id`, `instructor_email`
    - Verify instructor enrollment in the course (query `Enrolments` + `Users` table with role check)
    - Return 403 if not enrolled as instructor
    - INSERT into `Course_Modules` with `uuid_generate_v4()`, `status='draft'`, `concept_id=NULL`, `created_at=NOW()`, `updated_at=NOW()`
    - Return 201 with `{ module_id, status: 'draft' }`
    - _Requirements: 1.1, 1.2, 1.3, 9.1, 9.4, 9.5_

  - [x] 2.2 Implement POST /instructor/finalize_module route in instructorFunction.js
    - Add `case "POST /instructor/finalize_module":` to the switch statement
    - Validate required query params: `module_id`, `course_id`, `concept_id`, `module_name`, `module_number`, `instructor_email`
    - Parse body for optional `module_prompt` and `key_topics`
    - Verify instructor enrollment (403 if not enrolled)
    - Verify module exists with `status = 'draft'` (404 if not found)
    - Check duplicate `module_name` within `concept_id` (400 if duplicate)
    - Check `Module_Files` — reject with 409 if any have `processing_status` IN ('pending', 'processing')
    - UPDATE `Course_Modules`: set `concept_id`, `module_name`, `module_number`, `module_prompt`, `key_topics`, `status='active'`, `updated_at=NOW()`
    - INSERT `Student_Modules` for all enrollments in the course
    - INSERT `User_Engagement_Log` entry with type `instructor_created_module`
    - Return 200 with the updated module record
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 9.2, 9.4, 9.5_

  - [x] 2.3 Implement POST /instructor/cleanup_module route in instructorFunction.js
    - Add `case "POST /instructor/cleanup_module":` to the switch statement
    - Validate required query params: `module_id`, `course_id`, `instructor_email`
    - Verify instructor enrollment (403 if not enrolled)
    - Verify module status is `draft` or `deleting` (400 if `active`)
    - Set `status = 'deleting'` on the `Course_Modules` record
    - Delete vector embeddings: `DELETE FROM langchain_pg_embedding WHERE collection_id = (SELECT uuid FROM langchain_pg_collection WHERE name = module_id::text)`
    - Delete collection record: `DELETE FROM langchain_pg_collection WHERE name = module_id::text`
    - Delete `Module_Files` records for the module
    - Delete S3 objects under `{course_id}/{module_id}/documents/` prefix using AWS SDK
    - Delete the `Course_Modules` record
    - All steps idempotent — missing resources treated as already deleted
    - Return 200 with `{ message: "Module cleaned up successfully" }`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 9.3, 9.4, 9.5_

  - [ ]* 2.4 Write property test for finalization gate logic (Property 6)
    - **Property 6: Processing files block finalization**
    - Test that for any set of Module_Files with at least one `pending` or `processing` status, finalization returns 409
    - Test that files with `complete` or `failed` do not block; zero files do not block
    - Use fast-check to generate random file status combinations
    - **Validates: Requirements 4.7, 4.8, 4.9, 4.10**

  - [ ]* 2.5 Write property test for cleanup state guard (Property 9)
    - **Property 9: Cleanup rejects non-draft/non-deleting modules**
    - Test that calling cleanup on a module with `status = 'active'` returns 400 and leaves the record unchanged
    - Use fast-check to generate random module status values
    - **Validates: Requirements 5.7**

  - [ ]* 2.6 Write property test for authorization enforcement (Property 15)
    - **Property 15: Course enrollment gates all module lifecycle operations**
    - Test that for any user not enrolled as instructor, reserve/finalize/cleanup return 403
    - Test that enrolled instructors are not rejected on authorization grounds
    - Use fast-check to generate random enrollment states
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5**

- [x] 3. Checkpoint - Backend routes verification
  - Ensure all CDK changes compile (`npx tsc --noEmit` in cdk/)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. API Gateway routes and student view isolation
  - [x] 4.1 Add API Gateway routes for reserve_module, finalize_module, cleanup_module
    - Add `POST /instructor/reserve_module` resource and method to `cdk/OpenAPI_Swagger_Definition.yaml`
    - Add `POST /instructor/finalize_module` resource and method
    - Add `POST /instructor/cleanup_module` resource and method
    - Wire all three to instructorFunction Lambda via aws_proxy integration
    - Use the existing instructor authorizer for authentication
    - Add CORS OPTIONS methods for each route
    - _Requirements: 1.1, 4.1, 5.1_

  - [x] 4.2 Add student view isolation WHERE clause
    - Modify student-facing module queries in `cdk/lambda/lib/studentFunction.js` (or equivalent)
    - Add `AND "Course_Modules".status = 'active'` to all student module listing queries
    - Add the same filter to `verifyStudentAccess` to prevent direct access to draft module resources
    - _Requirements: 2.1_

  - [ ]* 4.3 Write property test for draft module isolation (Property 2)
    - **Property 2: Draft module isolation from student views**
    - Test that for any set of Course_Modules with mixed statuses, student queries return only `active` modules
    - Use fast-check to generate random module status sets
    - **Validates: Requirements 2.1**

- [x] 5. Data ingestion Lambda guard
  - [x] 5.1 Add module status check to data ingestion Lambda
    - Modify `cdk/data_ingestion/src/main.py`
    - Add a helper function `get_module_status(module_id, connection)` that queries `SELECT status FROM "Course_Modules" WHERE module_id = %s`
    - At the start of file processing (after parsing file path, before processing), call `get_module_status`
    - If status is `'deleting'` or module not found (None): log warning with `logger.warning("Module is deleting or not found, skipping processing", extra={"module_id": module_id, "status": status})` and return success without processing
    - If status is `'draft'` or `'active'`: proceed with normal processing
    - _Requirements: 5.9, 5.10_

  - [ ]* 5.2 Write property test for data ingestion guard (Property 11)
    - **Property 11: Data ingestion skips modules with status = 'deleting'**
    - Test that for any module with `status = 'deleting'` or no record, processing is skipped
    - Test that `draft` and `active` modules are processed normally
    - Use fast-check to generate random module statuses
    - **Validates: Requirements 5.9, 5.10**

- [x] 6. Checkpoint - Backend complete
  - Ensure CDK compiles (`npx tsc --noEmit` in cdk/)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Frontend hook and page refactor
  - [x] 7.1 Create useDraftModule hook
    - Create `frontend/src/hooks/useDraftModule.js`
    - On mount: check `sessionStorage` for key `draft_module_{course_id}`
    - If found: verify with backend (call reserve endpoint to check — or a lightweight GET). If valid, reuse the module_id. If invalid (404), clear sessionStorage and reserve a new one
    - If not found: call `POST /instructor/reserve_module?course_id={courseId}&instructor_email={email}` via apiClient
    - Store returned `module_id` in sessionStorage
    - Expose: `{ moduleId, isReserving, reserveError, cleanup }`
    - `cleanup()`: calls `POST /instructor/cleanup_module`, clears sessionStorage
    - Handle reservation failure: set `reserveError`, do not store in sessionStorage
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 7.2 Refactor InstructorNewModule page to use useDraftModule
    - Modify `frontend/src/pages/instructor/InstructorNewModule.jsx`
    - Call `useDraftModule(courseId)` on mount to get `moduleId`
    - Pass `moduleId` to `useFileUpload` and `useProcessingPoller` hooks (from upload-progress-feedback spec)
    - File selection triggers immediate upload using the reserved `moduleId`
    - Disable Save button while: `isReserving || hasActiveUploads || hasProcessingFiles`
    - Show error state and disable file upload zone if `reserveError` is set
    - _Requirements: 1.4, 3.1, 3.2, 3.3, 3.4_

  - [x] 7.3 Implement Save action calling finalize_module
    - Modify the Save handler in `InstructorNewModule.jsx`
    - Replace the existing `POST /instructor/create_module` call with `POST /instructor/finalize_module`
    - Pass: `module_id`, `course_id`, `concept_id`, `module_name`, `module_number`, `instructor_email` as query params
    - Pass `module_prompt` and `key_topics` in request body
    - On success (200): clear sessionStorage, navigate to module list
    - On 400 (duplicate name): show inline error on module name field
    - On 409 (files processing): keep Save disabled, show "Files are still being processed" message
    - On error: display toast, keep form editable for retry
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.11_

  - [x] 7.4 Implement cleanup on cancel/navigate away
    - Add Back/Cancel button handler: call `cleanup()` from `useDraftModule`, then navigate away
    - Add `beforeunload` event listener: fire `fetch` with `keepalive: true` to cleanup endpoint
    - Include auth header and module_id/course_id in the keepalive request
    - Clear sessionStorage on cleanup
    - Ensure cleanup is best-effort — do not block navigation on failure
    - _Requirements: 5.1, 7.1, 7.2_

  - [ ]* 7.5 Write property test for save button disabled logic (Property 6 frontend)
    - **Property 6: Processing files block finalization (frontend)**
    - Test that Save is disabled when any tracked file has `pending` or `processing` status
    - Test that Save is enabled when all files are `complete` or `failed` (or no files)
    - Use fast-check to generate random file status combinations
    - **Validates: Requirements 3.4, 4.7, 4.8, 4.9, 4.10**

- [x] 8. Orphan cleanup Lambda and EventBridge schedule
  - [x] 8.1 Create orphan cleanup Lambda function
    - Create `cdk/lambda/orphanCleanup/orphanCleanup.py` (or container-based under a new directory)
    - Use Powertools Logger with `service="orphan-cleanup"` and `@logger.inject_lambda_context` decorator
    - Add X-Ray SDK bootstrap block per lambda-coding-standards
    - Query orphans: `SELECT module_id, course_id FROM "Course_Modules" WHERE (status = 'draft' AND created_at < NOW() - INTERVAL '24 hours') OR (status = 'deleting' AND updated_at < NOW() - INTERVAL '1 hour')`
    - For each orphan: perform same cleanup steps as cleanup_module (set deleting, delete embeddings, delete collection, delete Module_Files, delete S3 objects, delete record)
    - On error for any individual module: log with `logger.exception()` and continue with next
    - Return summary: `{ "processed": N, "failed": N, "errors": [...] }`
    - Connect to DB via RDS Proxy with `sslmode=require`
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 8.2 Add CDK infrastructure for orphan cleanup Lambda and EventBridge schedule
    - Add orphan cleanup Lambda in `cdk/lib/api-gateway-stack.ts` (or a new stack if appropriate)
    - Create a dedicated IAM role `orphanCleanupRole` with:
      - SecretsManager (scoped to `secretPathUser` ARN)
      - EC2 VPC networking (`ec2:CreateNetworkInterface`, `ec2:DescribeNetworkInterfaces`, `ec2:DeleteNetworkInterface`) with resource `'*'`
      - CloudWatch Logs scoped to the function's log group ARN
      - S3 `s3:ListBucket`, `s3:DeleteObject` scoped to dataIngestionBucket ARN
    - Add EventBridge Scheduler rule: `rate(6 hours)` targeting the orphan cleanup Lambda
    - Set `tracing: lambda.Tracing.ACTIVE` and `logRetention` per CDK conventions
    - Add VPC config (security group, private subnets)
    - _Requirements: 6.1, 6.2_

  - [ ]* 8.3 Write property test for orphan identification (Property 12)
    - **Property 12: Orphan identification by age threshold**
    - Test that the orphan query returns exactly modules matching the age criteria and no others
    - Use fast-check to generate random sets of modules with varying statuses and ages
    - **Validates: Requirements 6.1**

  - [ ]* 8.4 Write CDK assertion test for orphan cleanup infrastructure
    - Add test to `cdk/test/` verifying:
    - EventBridge rule exists with `rate(6 hours)` schedule
    - Orphan cleanup Lambda has correct IAM permissions (scoped)
    - Lambda is in VPC with correct security group
    - Lambda has required environment variables
    - _Requirements: 6.1, 6.2_

- [x] 9. Final checkpoint - Full verification
  - Run `npx tsc --noEmit` in `cdk/` to verify CDK TypeScript compiles
  - Run `npm run lint` in `frontend/` to verify ESLint passes
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The existing `POST /instructor/create_module` route is NOT modified — it remains for backward compatibility
- The `useDraftModule` hook integrates with the existing `useFileUpload` and `useProcessingPoller` hooks from the upload-progress-feedback spec
- Property tests use fast-check and target pure business logic (finalization gates, status guards, authorization)
- The orphan cleanup Lambda uses Python per lambda-coding-standards (Powertools Logger, X-Ray, sslmode=require)
- Cleanup is idempotent by design — missing resources are treated as already deleted
- The `beforeunload` cleanup uses `fetch` with `keepalive: true` (not sendBeacon) to support auth headers
- Checkpoints ensure incremental validation between backend and frontend phases

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 2, "tasks": ["2.4", "2.5", "2.6", "4.1", "4.2"] },
    { "id": 3, "tasks": ["4.3", "5.1"] },
    { "id": 4, "tasks": ["5.2", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 6, "tasks": ["7.5", "8.1"] },
    { "id": 7, "tasks": ["8.2"] },
    { "id": 8, "tasks": ["8.3", "8.4"] }
  ]
}
```
