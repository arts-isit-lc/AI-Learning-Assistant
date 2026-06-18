# Requirements Document

## Introduction

This feature changes the "Create New Module" flow so that a `module_id` is generated immediately when an instructor navigates to the New Module page. This enables files to begin uploading as soon as they are selected rather than waiting until the Save button is clicked. The current flow blocks uploads because the presigned URL endpoint requires a `module_id` that only exists after module creation. By eagerly reserving a draft module record, the New Module experience becomes consistent with the Edit Module flow where uploads happen immediately.

## Glossary

- **Module_Reservation_Service**: The backend endpoint responsible for creating a draft module record and returning a reserved `module_id` to the frontend.
- **Module_Finalization_Service**: The backend endpoint responsible for converting a draft module into an active module by setting its metadata and creating associated student records.
- **Module_Cleanup_Service**: The backend endpoint responsible for deleting a draft module and its associated uploaded files and vector embeddings.
- **Data_Ingestion_Lambda**: The Docker container Lambda responsible for processing uploaded files (extracting text, generating embeddings, storing in pgvector).
- **Draft_Module**: A `Course_Modules` record with `status = 'draft'` that has been reserved but not yet finalized by the instructor.
- **Active_Module**: A `Course_Modules` record with `status = 'active'` that is fully configured and visible to students.
- **Deleting_Module**: A `Course_Modules` record with `status = 'deleting'` that is in the process of being cleaned up and should not accept new processing work.
- **Orphan_Cleanup_Job**: A scheduled background mechanism that identifies and removes draft modules older than a configured time-to-live threshold.
- **Frontend_New_Module_Page**: The instructor-facing page at `/instructor/new-module` where module creation occurs.
- **Presigned_URL_Endpoint**: The existing Lambda function (`generatePreSignedURL`) that generates S3 presigned upload URLs, requiring a valid `module_id`.
- **Module_Files**: The database table tracking individual files associated with a module, including a `processing_status` column (`pending`, `processing`, `complete`, `failed`) that records the ingestion pipeline state for each file.
- **module_number**: A sequential integer per course assigned by the frontend as `data.length + 1`. The backend does NOT enforce uniqueness on `module_number`; this is pre-existing behavior and not changed by this feature.

## Requirements

### Requirement 1: Reserve a Draft Module on Page Load

**User Story:** As an instructor, I want a module_id to be available immediately when I open the New Module page, so that I can start uploading files without waiting for Save.

#### Acceptance Criteria

1. WHEN an instructor navigates to the Frontend_New_Module_Page, THE Frontend_New_Module_Page SHALL call the Module_Reservation_Service with the `course_id`.
2. WHEN the Module_Reservation_Service receives a valid `course_id`, THE Module_Reservation_Service SHALL insert a new record into `Course_Modules` with a server-generated UUID v4 as `module_id` and `status` set to `draft`.
3. WHEN the Module_Reservation_Service successfully creates a draft record, THE Module_Reservation_Service SHALL return the generated `module_id` to the caller within 2 seconds.
4. IF the Module_Reservation_Service fails to create a draft record, THEN THE Frontend_New_Module_Page SHALL display an error message and prevent file uploads.
5. WHEN the Frontend_New_Module_Page receives a `module_id` from the Module_Reservation_Service, THE Frontend_New_Module_Page SHALL store the `module_id` in `sessionStorage`.
6. WHEN the Frontend_New_Module_Page loads and a draft `module_id` already exists in `sessionStorage`, THE Frontend_New_Module_Page SHALL call the Module_Reservation_Service to verify the draft still exists and reuse it rather than creating a new draft.
7. IF the stored draft `module_id` no longer exists on the server, THEN THE Frontend_New_Module_Page SHALL clear `sessionStorage` and create a new draft via the Module_Reservation_Service.

### Requirement 2: Draft Module Isolation from Student Views

**User Story:** As a student, I want to only see finalized modules, so that I am not confused by incomplete instructor work.

#### Acceptance Criteria

1. Draft modules SHALL NOT appear in any student-facing view or API response.

### Requirement 3: Immediate File Upload with Reserved Module ID

**User Story:** As an instructor, I want files to start uploading as soon as I select them on the New Module page, so that I do not have to wait for Save to complete before uploads begin.

#### Acceptance Criteria

1. WHEN the Frontend_New_Module_Page receives a `module_id` from the Module_Reservation_Service, THE Frontend_New_Module_Page SHALL initialize the file upload hook with that `module_id`.
2. WHEN the instructor selects files for upload, THE Frontend_New_Module_Page SHALL immediately request presigned URLs from the Presigned_URL_Endpoint using the reserved `module_id`.
3. WHEN a presigned URL is returned, THE Frontend_New_Module_Page SHALL begin uploading the file via XHR with progress tracking.
4. WHILE files are uploading or processing, THE Frontend_New_Module_Page SHALL disable the Save button.

### Requirement 4: Module Finalization on Save

**User Story:** As an instructor, I want clicking Save to finalize my module with all its metadata, so that students can access the completed module.

#### Acceptance Criteria

1. WHEN the instructor clicks Save with valid module metadata, THE Frontend_New_Module_Page SHALL call the Module_Finalization_Service with the reserved `module_id`, `concept_id`, `module_name`, `module_number`, `module_prompt`, and `key_topics`.
2. WHEN the Module_Finalization_Service receives a finalization request, THE Module_Finalization_Service SHALL verify that a module with the same name does not already exist within the same concept.
3. IF a module with the same name already exists within the concept, THEN THE Module_Finalization_Service SHALL return a 400 error indicating a duplicate name.
4. WHEN the Module_Finalization_Service validates the request, THE Module_Finalization_Service SHALL update the draft record with the provided metadata and set `status` to `active`.
5. WHEN the Module_Finalization_Service sets a module to active, THE Module_Finalization_Service SHALL create `Student_Modules` entries for all students enrolled in the course.
6. WHEN the Module_Finalization_Service sets a module to active, THE Module_Finalization_Service SHALL create a `User_Engagement_Log` entry with type `instructor_created_module`.
7. WHEN the Module_Finalization_Service receives a finalization request, THE Module_Finalization_Service SHALL verify that all associated files in `Module_Files` for that `module_id` have a `processing_status` of `complete` or `failed`.
8. IF any file in `Module_Files` for the requested `module_id` has `processing_status` of `pending` or `processing`, THEN THE Module_Finalization_Service SHALL reject the request with HTTP 409 and message "Files are still being processed."
9. Files with `processing_status = 'failed'` SHALL NOT prevent module activation. Only `pending` or `processing` states block finalization.
10. THE Module_Finalization_Service SHALL NOT reject activation solely because no files exist. A module with zero uploaded files is valid for activation. The frontend may enforce a minimum file count as a UX choice, but the backend allows it.
11. IF the Module_Finalization_Service rejects a finalization request due to validation error or duplicate name, THEN the draft module record and all associated uploaded files SHALL remain intact so the instructor can correct the issue and retry Save.

### Requirement 5: Cleanup on Cancel

**User Story:** As an instructor, I want abandoned draft modules to be cleaned up, so that unused data does not accumulate in the system.

#### Acceptance Criteria

1. WHEN the instructor navigates away from the Frontend_New_Module_Page without saving, THE Frontend_New_Module_Page SHALL call the Module_Cleanup_Service with the reserved `module_id`.
2. WHEN the Module_Cleanup_Service receives a valid draft `module_id`, THE Module_Cleanup_Service SHALL set `status = 'deleting'` on the `Course_Modules` record to prevent new processing work from starting.
3. WHEN the Module_Cleanup_Service has set `status = 'deleting'`, THE Module_Cleanup_Service SHALL delete all vector embeddings associated with the module from the pgvector store.
4. WHEN the Module_Cleanup_Service has deleted vector embeddings, THE Module_Cleanup_Service SHALL delete all records from `Module_Files` where `module_id` matches.
5. WHEN the Module_Cleanup_Service has deleted file records, THE Module_Cleanup_Service SHALL delete all S3 objects under the module's prefix path (`{course_id}/{module_id}/documents/`).
6. WHEN the Module_Cleanup_Service has deleted S3 objects, THE Module_Cleanup_Service SHALL delete the `Course_Modules` record itself.
7. IF the Module_Cleanup_Service receives a `module_id` that is not in `draft` or `deleting` status, THEN THE Module_Cleanup_Service SHALL reject the request with a 400 error.
8. Cleanup operations SHALL be idempotent. If a resource (module record, file record, S3 object, or embedding) does not exist at the time of deletion, THE Module_Cleanup_Service SHALL treat it as successfully deleted without raising an error.
9. THE Data_Ingestion_Lambda SHALL handle the case where a module is deleted or has `status = 'deleting'` while processing is in progress by logging a warning and discarding results without error when it cannot find the module record.
10. IF the module's status is `deleting` when processing begins, THEN THE Data_Ingestion_Lambda SHALL skip processing and discard the event without error.

### Requirement 6: Orphan Draft Cleanup

**User Story:** As a system operator, I want orphaned draft modules to be automatically cleaned up, so that the database does not accumulate stale records from crashed sessions.

#### Acceptance Criteria

1. THE Orphan_Cleanup_Job SHALL identify all modules with `status = 'draft'` older than 24 hours AND all modules with `status = 'deleting'` older than 1 hour.
2. WHEN the Orphan_Cleanup_Job identifies an orphaned module, THE Orphan_Cleanup_Job SHALL perform the same cleanup steps as the Module_Cleanup_Service for that module.
3. IF the Orphan_Cleanup_Job encounters an error cleaning a specific draft module, THEN THE Orphan_Cleanup_Job SHALL log the error and continue processing remaining orphaned drafts.

### Requirement 7: Best-Effort Browser Cleanup

**User Story:** As an instructor, I want the system to attempt cleanup even if I close my browser tab, so that abandoned drafts do not persist unnecessarily.

#### Acceptance Criteria

1. WHEN the browser `beforeunload` event fires on the Frontend_New_Module_Page with an unsaved draft, THE Frontend_New_Module_Page SHALL send a cleanup request to the Module_Cleanup_Service using `navigator.sendBeacon` or an equivalent best-effort mechanism.
2. WHEN the instructor clicks the Back button on the Frontend_New_Module_Page with an unsaved draft, THE Frontend_New_Module_Page SHALL call the Module_Cleanup_Service before navigating away.

### Requirement 8: Database Schema Extension

**User Story:** As a developer, I want the Course_Modules table to track module lifecycle status, so that draft and active modules can be distinguished.

#### Acceptance Criteria

1. THE `Course_Modules` table SHALL have a `status` column of type `VARCHAR` with a default value of `active`.
2. THE `status` column SHALL accept only the values `draft`, `active`, and `deleting`.
3. WHEN the database migration adds the `status` column, THE migration SHALL set all existing records to `active` to preserve backward compatibility.
4. THE file-level processing state SHALL be tracked separately in the `Module_Files.processing_status` column, independent of the module-level `status` column.


### Requirement 9: Ownership Validation

**User Story:** As a system operator, I want all module lifecycle operations to verify instructor course enrollment, so that only instructors enrolled in the course can manage draft modules within that course.

#### Acceptance Criteria

1. WHEN the Module_Reservation_Service receives a reservation request, THE Module_Reservation_Service SHALL verify that the requesting instructor is enrolled in the specified course with an instructor role.
2. WHEN the Module_Finalization_Service receives a finalization request, THE Module_Finalization_Service SHALL verify that the requesting instructor is enrolled in the course associated with the draft module with an instructor role.
3. WHEN the Module_Cleanup_Service receives a cleanup request, THE Module_Cleanup_Service SHALL verify that the requesting instructor is enrolled in the course associated with the draft module with an instructor role.
4. Any instructor enrolled in the course may reserve, finalize, or clean up draft modules within that course. Authorization is not limited to the original creator of the draft module.
5. IF enrollment validation fails for any module lifecycle operation, THEN the service SHALL return HTTP 403 Forbidden.
