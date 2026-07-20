import { z } from "zod"

// Runtime API contracts for the instructor slice (Phase 6). Shapes are derived
// from the fields the UI actually consumes (see the legacy instructor pages);
// `.passthrough()` keeps extra backend fields rather than dropping them. Lenient
// by design — tightened per-feature as screens are built. Wizard/edit/chat-log
// contracts are appended in their batches (6d/6e).

// --- Instructor course list (GET instructor/courses) ---
export const InstructorCourseSchema = z
  .object({
    course_id: z.string(),
    course_name: z.string(),
    course_department: z.string(),
    course_number: z.union([z.string(), z.number()]),
    course_student_access: z.boolean().nullable().optional(),
  })
  .passthrough()
export const InstructorCoursesSchema = z.array(InstructorCourseSchema)

// --- Concepts (GET instructor/view_concepts) ---
export const ConceptSchema = z
  .object({
    concept_id: z.string(),
    concept_name: z.string(),
    concept_number: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough()
export const ConceptsSchema = z.array(ConceptSchema)

// --- Modules (GET instructor/view_modules) ---
export const InstructorModuleSchema = z
  .object({
    module_id: z.string(),
    module_name: z.string(),
    concept_name: z.string().nullable().optional(),
    concept_id: z.string().nullable().optional(),
    module_prompt: z.string().nullable().optional(),
    module_number: z.union([z.string(), z.number()]).nullable().optional(),
    key_topics: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  })
  .passthrough()
export const InstructorModulesSchema = z.array(InstructorModuleSchema)

// --- Prompt conflict report (POST instructor/validate_prompt, and the stored
//     conflict_metadata round-tripped via get_prompt/prompt) ---
export const ConflictSchema = z
  .object({
    type: z.string().nullable().optional(),
    severity: z.string().nullable().optional(),
    prompt_a_source: z.string().nullable().optional(),
    prompt_a_text: z.string().nullable().optional(),
    prompt_b_source: z.string().nullable().optional(),
    prompt_b_text: z.string().nullable().optional(),
    explanation: z.string().nullable().optional(),
  })
  .passthrough()
export const ConflictReportSchema = z
  .object({
    validation_status: z.string().nullable().optional(),
    conflicts: z.array(ConflictSchema).nullable().optional(),
    has_conflicts: z.boolean().nullable().optional(),
    summary: z.string().nullable().optional(),
  })
  .passthrough()

// --- Course prompt + model (GET instructor/get_prompt, PUT instructor/prompt) ---
export const CoursePromptSchema = z
  .object({
    system_prompt: z.string().nullable().optional(),
    llm_model_id: z.string().nullable().optional(),
    conflict_metadata: ConflictReportSchema.nullable().optional(),
  })
  .passthrough()

// --- Previous prompts (GET instructor/previous_prompts) ---
export const PreviousPromptSchema = z
  .object({
    previous_prompt: z.string(),
    timestamp: z.string().nullable().optional(),
  })
  .passthrough()
export const PreviousPromptsSchema = z.array(PreviousPromptSchema)

// --- Analytics (GET instructor/analytics) — per-module rows ---
export const AnalyticsRowSchema = z
  .object({
    module_name: z.string(),
    message_count: z.number().nullable().optional(),
    perfect_score_percentage: z.number().nullable().optional(),
    access_count: z.number().nullable().optional(),
  })
  .passthrough()
export const AnalyticsSchema = z.array(AnalyticsRowSchema)

// --- Roster (GET instructor/view_students) ---
export const RosterStudentSchema = z
  .object({
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    user_email: z.string(),
  })
  .passthrough()
export const RosterSchema = z.array(RosterStudentSchema)

// --- Access code. NOTE the field-name mismatch between the two endpoints:
//     GET instructor/get_access_code       -> { course_access_code }
//     PUT instructor/generate_access_code  -> { access_code }
//     The hooks normalize both to a single `code` string. ---
export const AccessCodeSchema = z
  .object({ course_access_code: z.string().nullable().optional() })
  .passthrough()
export const GeneratedAccessCodeSchema = z
  .object({ access_code: z.string().nullable().optional() })
  .passthrough()

// --- Course files (GET instructor/course_files) — used for cross-module
//     reference selection in the module wizard/editor ---
export const CourseFileSchema = z
  .object({
    file_id: z.string(),
    filename: z.string().nullable().optional(),
    filetype: z.string().nullable().optional(),
    module_id: z.string().nullable().optional(),
    module_name: z.string().nullable().optional(),
  })
  .passthrough()
export const CourseFilesSchema = z.array(CourseFileSchema)

// --- Module file references (GET instructor/module_file_references) — file_ids ---
export const ModuleFileReferencesSchema = z.array(z.string())

// --- All files for a module (GET instructor/get_all_files). document_files is a
//     map keyed by file name; each value carries a url + (possibly stringified)
//     metadata. Kept lenient — flattened to an array in the hook. ---
export const ModuleAllFilesSchema = z
  .object({ document_files: z.record(z.string(), z.any()).nullable().optional() })
  .passthrough()

// --- Chat logs (GET instructor/fetch_chatlogs) — a map of fileName -> presigned URL ---
export const ChatLogsSchema = z
  .object({ log_files: z.record(z.string(), z.string()).nullable().optional() })
  .passthrough()

// --- Chat-log job status (GET instructor/check_notifications_status) ---
export const ChatlogStatusSchema = z
  .object({
    isEnabled: z.boolean().nullable().optional(),
    completionStatus: z.boolean().nullable().optional(),
    requestId: z.string().nullable().optional(),
  })
  .passthrough()

// --- Per-student chat history (GET instructor/student_modules_messages) —
//     an object keyed by module/tab name -> sessions -> messages. The exact
//     shape is inferred from the legacy viewer, so this stays lenient (like
//     message_blocks) and is shaped defensively at render. ---
export const StudentMessagesSchema = z.record(z.string(), z.any())

/** @typedef {z.infer<typeof InstructorCourseSchema>} InstructorCourse */
/** @typedef {z.infer<typeof ConceptSchema>} Concept */
/** @typedef {z.infer<typeof InstructorModuleSchema>} InstructorModule */
/** @typedef {z.infer<typeof ConflictReportSchema>} ConflictReport */
/** @typedef {z.infer<typeof CoursePromptSchema>} CoursePrompt */
/** @typedef {z.infer<typeof AnalyticsRowSchema>} AnalyticsRow */
/** @typedef {z.infer<typeof RosterStudentSchema>} RosterStudent */
