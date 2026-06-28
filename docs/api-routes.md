# API Routes

Complete mapping of REST API routes to their handling Lambda functions.

All routes are served via API Gateway (WAF-protected) with Cognito authorization.

---

## Student Routes → `studentFunction` (zip Lambda)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/student/create_user` | Register new user in RDS |
| GET | `/student/get_user_roles` | Get Cognito group membership |
| GET | `/student/get_name` | Get user display name |
| GET | `/student/course` | Get enrolled courses |
| GET | `/student/course_page` | Get course details with modules |
| GET | `/student/module` | Get sessions for a module |
| POST | `/student/create_session` | Create new chat session |
| DELETE | `/student/delete_session` | Delete a chat session |
| GET | `/student/get_messages` | Get messages for a session |
| POST | `/student/enroll_student` | Enroll student in course via access code |
| GET | `/session/messages` | Get session messages (alternate path) |
| PUT | `/student/update_session_name` | Rename a chat session |
| POST | `/student/update_module_score` | Update module progress score |
| GET | `/student/files` | List files in a module |
| GET | `/student/file_url` | Get presigned URL for file download |
| GET | `/student/figure_url` | Get presigned URL for figure image |

## Instructor Routes → `instructorFunction` (zip Lambda)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/instructor/courses` | List instructor's courses |
| GET | `/instructor/student_course` | View student's course progress |
| GET | `/instructor/analytics` | Course/module analytics data |
| POST | `/instructor/create_concept` | Create new concept (topic group) |
| PUT | `/instructor/edit_concept` | Rename/edit concept |
| DELETE | `/instructor/delete_concept` | Delete concept |
| PUT | `/instructor/update_metadata` | Update course metadata |
| POST | `/instructor/create_module` | Create new module |
| PUT | `/instructor/reorder_module` | Change module ordering |
| PUT | `/instructor/edit_module` | Edit module details |
| DELETE | `/instructor/delete_module` | Delete module |
| PUT | `/instructor/prompt` | Update course system prompt |
| GET | `/instructor/get_prompt` | Get current system prompt |
| GET | `/instructor/previous_prompts` | Get prompt history |
| POST | `/instructor/validate_prompt` | Validate prompt via LLM |
| POST | `/instructor/generate_topics` | Auto-generate module topics |
| GET | `/instructor/view_students` | List enrolled students |
| DELETE | `/instructor/delete_student` | Remove student from course |
| GET | `/instructor/view_modules` | List modules in a concept |
| GET | `/instructor/view_concepts` | List concepts in a course |
| GET | `/instructor/view_student_messages` | View student chat history |
| GET | `/instructor/student_modules_messages` | Student progress per module |
| PUT | `/instructor/generate_access_code` | Generate new access code |
| GET | `/instructor/get_access_code` | Get current access code |
| GET | `/instructor/check_notifications_status` | Check async job notifications |
| DELETE | `/instructor/remove_completed_notification` | Clear notification |
| GET | `/instructor/course_files` | List all files in course |
| GET | `/instructor/module_file_references` | Get file→module mappings |
| PUT | `/instructor/module_file_references` | Update file→module mappings |
| GET | `/instructor/file_processing_statuses` | Check ingestion status per file |
| POST | `/instructor/reserve_module` | Reserve module for editing |
| POST | `/instructor/finalize_module` | Finalize module (trigger ingestion) |
| POST | `/instructor/cleanup_module` | Delete module files from S3 |

## Admin Routes → `adminFunction` (zip Lambda)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/admin/instructors` | List all instructors |
| GET | `/admin/courses` | List all courses |
| POST | `/admin/enroll_instructor` | Assign instructor to course |
| POST | `/admin/create_course` | Create new course |
| GET | `/admin/courseInstructors` | List instructors for a course |
| GET | `/admin/instructorCourses` | List courses for an instructor |
| POST | `/admin/updateCourseAccess` | Toggle course student access |
| DELETE | `/admin/delete_instructor_enrolments` | Remove instructor from course |
| DELETE | `/admin/delete_course_instructor_enrolments` | Remove all instructors from course |
| DELETE | `/admin/delete_course` | Delete course entirely |
| POST | `/admin/elevate_instructor` | Promote to admin |
| POST | `/admin/lower_instructor` | Demote from admin |

## Standalone Lambda Routes

| Method | Path | Lambda | Purpose |
|--------|------|--------|---------|
| POST | `/student/chatbot-v2` | `chatbotV2Function` (MultimodalRagStack) | Structured learning chatbot — evaluates, generates, streams |
| DELETE | `/student/delete_last_message` | `deleteLastMessage` (zip) | Delete most recent message pair |
| POST | `/instructor/generate_presigned_url` | `generatePreSignedURL` (zip, Python) | S3 upload URL for file uploads |
| GET | `/instructor/get_all_files` | `getFilesFunction` (zip) | List all files across modules |
| DELETE | `/instructor/delete_file` | `deleteFileFunction` (zip) | Delete file from S3 + RDS |
| DELETE | `/instructor/delete_module_s3` | `deleteFileFunction` (zip) | Delete module files from S3 |
| POST | `/instructor/fetch_chatlogs` | SQS → `sqsTrigger` (Docker) | Export chat logs (async via SQS) |
| POST | `/instructor/events_notify` | `notificationFunction` (zip) | Send AppSync notification |
| GET | `/instructor/course_messages` | `notificationFunction` (zip) | Get course-wide message stats |

## WebSocket (AppSync GraphQL)

| Subscription | Purpose |
|---|---|
| `onChatChunk(session_id)` | Stream AI response chunks to frontend |
| `onNotify(request_id)` | Notify frontend of async job completion |
