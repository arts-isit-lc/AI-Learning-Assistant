# Implementation Plan: Student PDF Viewer

## Overview

This plan implements a side-by-side PDF viewer in the student chat interface. Work proceeds backend-first (Lambda handler + IAM + API Gateway routes), then frontend (file list popover, PDF panel component, layout changes). Each phase has a checkpoint to catch issues early.

## Tasks

- [x] 1. Add backend support for student file access
  - [x] 1.1 Add `s3:GetObject` permission to `dbLambdaRole` in `api-gateway-stack.ts`
    - Add a new `PolicyStatement` with action `s3:GetObject` and resource `${dataIngestionBucket.bucketArn}/*`
    - Add `BUCKET: dataIngestionBucket.bucketName` and `REGION: this.region` to the `studentFunction` environment variables
    - Do NOT add `s3:PutObject`, `s3:DeleteObject`, or `s3:ListBucket`
    - _Requirements: 3.1, 3.2, 3.4_

  - [x] 1.2 Implement `verifyStudentAccess` helper function in `studentFunction.js`
    - Add a shared async function that accepts `sqlConnection`, `email`, `courseId`, `moduleId`
    - Joins Enrolments → Users → Course_Concepts → Course_Modules to verify module belongs to the student's enrolled course
    - Returns `enrolment_id` if valid, `null` if not enrolled
    - The join chain prevents mixed-parameter attacks (course_id from Course A + module_id from Course B)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 1.3 Add `GET /student/files` route handler to `studentFunction.js`
    - Add a new `case "GET /student/files"` in the switch statement
    - Extract email from `event.requestContext.authorizer.email` — do NOT accept email as a query parameter
    - Validate required query params: `course_id`, `module_id`
    - Call `verifyStudentAccess()` — return 403 if null
    - Query `Module_Files` table for all records matching `module_id`, returning `file_id`, `filename`, `filetype`, `time_uploaded`
    - Return 200 with file array (or empty array if no files)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 1.4 Add `GET /student/file_url` route handler to `studentFunction.js`
    - Add a new `case "GET /student/file_url"` in the switch statement
    - Extract email from `event.requestContext.authorizer.email` — do NOT accept email as a query parameter
    - Validate required query param: `file_id`
    - Look up file record by `file_id` in `Module_Files` — return 404 if not found
    - Resolve `course_id` from the file's `module_id` via Course_Modules → Course_Concepts
    - Call `verifyStudentAccess()` — return 403 if null
    - Import `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` at the top of the file
    - Generate a GET pre-signed URL using the stored `filepath` column as S3 key, TTL of 3600 seconds (1 hour)
    - Return 200 with `{ presignedurl }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8_

  - [x] 1.5 Add the two new API routes to `OpenAPI_Swagger_Definition.yaml`
    - Add `/student/files` path with CORS options method and GET method, secured by `studentAuthorizer`, integrated with `studentFunction`
    - Parameters: `course_id`, `module_id` (query) — no `email` parameter
    - Add `/student/file_url` path with CORS options method and GET method, secured by `studentAuthorizer`, integrated with `studentFunction`
    - Parameters: `file_id` (query) — no `email` parameter
    - Follow the exact pattern used by existing student routes (e.g., `/student/get_messages`)
    - _Requirements: 1.7, 2.7_

- [x] 2. Checkpoint — Verify backend changes compile and synth
  - Run `npx tsc --noEmit` in the `cdk/` directory to type-check
  - Verify the OpenAPI YAML is valid (no syntax errors during synth)
  - _Requirements: 3.1, 3.2_

- [x] 3. Add IAM assertion test
  - [x] 3.1 Add test case to `cdk/test/iam-policies.test.ts`
    - Verify `dbLambdaRole` has `s3:GetObject` permission scoped to the data ingestion bucket ARN with `/*` suffix
    - Verify `dbLambdaRole` does NOT have `s3:PutObject`, `s3:DeleteObject`, or `s3:ListBucket` on the data ingestion bucket (these belong to other roles)
    - _Requirements: 3.3_

- [x] 4. Install frontend dependencies
  - [x] 4.1 Install `react-pdf` and `lucide-react` in the frontend
    - Run `npm install react-pdf lucide-react` in the `frontend/` directory
    - _Requirements: 5.3_

- [x] 5. Build the PDF viewer panel component
  - [x] 5.1 Create `frontend/src/components/PdfViewerPanel.jsx`
    - Import `Document` and `Page` from `react-pdf`, configure the PDF.js worker
    - Accept props: `file`, `pdfUrl`, `files`, `onFileSelect`, `onClose`, `onRetry`, `loading`
    - `onFileSelect` receives a `file_id` — the parent handles fetching the new URL
    - Implement page navigation (previous, next, page number display)
    - Implement zoom controls (zoom in, zoom out, reset — range 50% to 200%)
    - Implement loading state with Skeleton placeholder
    - Implement error state with "Retry" button
    - Include a header with file name and a dropdown/button to switch files
    - Include a close button (X icon with tooltip and aria-label)
    - Use Tailwind classes only, follow the 4pt spacing grid and semantic color tokens
    - Use lucide-react icons (`ChevronLeft`, `ChevronRight`, `ZoomIn`, `ZoomOut`, `X`, `FileText`)
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x] 5.2 Add responsive full-screen overlay mode
    - Below `md` breakpoint, render the panel as a fixed full-screen overlay with z-50
    - Include a back button (top-left) to close the overlay and return to chat
    - Above `md` breakpoint, render as a side panel within the flex layout
    - _Requirements: 6.1, 6.2_

- [x] 6. Integrate PDF viewer into StudentChat
  - [x] 6.1 Add file list fetching and state management to `StudentChat.jsx`
    - Add state variables: `moduleFiles` (null = not yet fetched), `filesLoading`, `selectedFile`, `pdfUrl`, `pdfPanelOpen`
    - Add `handleFetchFiles` function: calls `GET /student/files` with `course_id` and `module_id`, caches result in state
    - Add `handleFileSelect` function: calls `GET /student/file_url` with `file_id`, sets `pdfUrl` and `pdfPanelOpen`
    - Add `handlePdfClose` function: sets `pdfPanelOpen` to false, clears `selectedFile` and `pdfUrl`
    - Add `handlePdfRetry` function: re-fetches the pre-signed URL for the current `selectedFile.file_id`
    - Use cached `moduleFiles` on subsequent popover opens — only fetch once per module session
    - _Requirements: 4.1, 4.2, 4.5, 4.8_

  - [x] 6.2 Add "View Materials" button and file list popover to the chat header
    - Render a button with `FileText` icon and "View Materials" text in the chat header area (always visible)
    - On click, call `handleFetchFiles` (if not already cached) then open a Popover
    - Show Skeleton rows while `filesLoading` is true
    - If file list is empty, show "No materials available" message
    - If file list has items, show each file with name and type badge
    - Clicking a file calls `handleFileSelect(file.file_id)` and closes the popover
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 4.7, 6.3_

  - [x] 6.3 Adjust layout widths when PDF panel is open
    - When `pdfPanelOpen` is false: sessions sidebar `w-1/4`, chat area `w-3/4` (existing)
    - When `pdfPanelOpen` is true: sessions sidebar `w-1/5`, chat area `w-2/5`, PDF panel `w-2/5`
    - Render `PdfViewerPanel` conditionally based on `pdfPanelOpen`
    - Ensure smooth width transition (optional: add `transition-all duration-200`)
    - _Requirements: 5.1, 5.2_

- [x] 7. Checkpoint — Verify frontend builds
  - Run `npm run build` in the `frontend/` directory to ensure no build errors
  - Run `npm run lint` to check for ESLint issues
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 8. Final verification
  - [x] 8.1 Run CDK tests
    - Run `npm test` in the `cdk/` directory (requires Docker) to verify all assertion tests pass including the new IAM test
    - _Requirements: 3.3_

  - [x] 8.2 Run CDK type check
    - Run `npx tsc --noEmit` in the `cdk/` directory to verify no type errors
    - _Requirements: 3.1, 3.2_

## Notes

- The `studentFunction` is a Node.js 22 zip Lambda using the `postgres` library (tagged template literals). The S3 pre-signed URL generation uses `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` which are available in the Node.js 22 runtime without bundling.
- The `react-pdf` package requires a PDF.js worker. The worker is loaded from unpkg CDN by default; for production, consider copying the worker file to the public directory using Vite's public asset handling.
- The `verifyStudentAccess()` helper is shared between both new endpoints. Its join chain (Enrolments → Course_Concepts → Course_Modules) explicitly prevents mixed-parameter attacks where course_id and module_id belong to different courses.
- The document URL endpoint uses the stored `filepath` column from Module_Files as the S3 key, rather than reconstructing it from parts. This prevents drift between DB records and S3 objects.
- The 1-hour TTL on pre-signed URLs accounts for PDF.js range request behavior on large documents. This should be verified during integration testing with a 300+ page PDF.
- This feature only handles PDF rendering. Other file types (docx, pptx, etc.) will show in the file list but should display a "Preview not available" message with a download link as a fallback. This can be addressed in a follow-up.
- The future page-level citation feature can build on this by passing a `page` prop to `PdfViewerPanel` to auto-navigate to a specific page.
- Mobile UX (constant context-switching between PDF and chat) is a known limitation for V1. A future iteration could introduce a bottom sheet or split-screen tablet layout.
