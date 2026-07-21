import { z } from "zod"

// Runtime API contracts for the student read path (Phase 3). Shapes are derived
// from what the frontend actually consumes; `.passthrough()` keeps any extra
// backend fields rather than dropping them. Schemas are tightened per-feature as
// screens are built (Phase 5).

// --- Courses (GET student/course, GET instructor/student_course) ---
export const CourseSchema = z
  .object({
    course_id: z.string(),
    course_department: z.string(),
    course_number: z.union([z.string(), z.number()]),
    course_name: z.string(),
  })
  .passthrough()
export const CoursesSchema = z.array(CourseSchema)

// --- Per-course progress summary (GET student/progress_summary) ---
// Server-aggregated completion for the home grid: one row per accessible
// enrolled course. `percent` = completed/total concepts (a concept is complete
// when its active modules average a score of 100).
export const CourseProgressSummarySchema = z.array(
  z
    .object({
      course_id: z.string(),
      percent: z.number(),
      completed: z.number(),
      total: z.number(),
    })
    .passthrough()
)

// --- Course page (GET student/course_page) — flat concept+module rows ---
export const CoursePageRowSchema = z
  .object({
    concept_id: z.string(),
    concept_name: z.string(),
    module_id: z.string(),
    module_name: z.string(),
    module_score: z.number().nullable().optional(),
    last_accessed: z.string().nullable().optional(),
  })
  .passthrough()
export const CoursePageSchema = z.array(CoursePageRowSchema)

// --- Sessions (GET student/module, POST student/create_session) ---
export const SessionSchema = z
  .object({
    session_id: z.string(),
    session_name: z.string(),
  })
  .passthrough()
export const SessionsSchema = z.array(SessionSchema)

// --- Messages (GET student/get_messages) ---
export const MessageSchema = z
  .object({
    message_id: z.union([z.string(), z.number()]),
    message_content: z.string(),
    student_sent: z.boolean(),
    session_id: z.string(),
    time_sent: z.string().nullable().optional(),
    // JSONB render blocks (figures/tables/formulas); shapes validated at render.
    message_blocks: z.array(z.any()).nullable().optional(),
  })
  .passthrough()
export const MessagesSchema = z.array(MessageSchema)

// --- Module files (GET student/files) ---
export const ModuleFileSchema = z
  .object({
    file_id: z.string(),
    file_name: z.string().optional(),
    file_type: z.string().optional(),
  })
  .passthrough()
export const ModuleFilesSchema = z.array(ModuleFileSchema)

// --- Presigned file URL (GET student/file_url) ---
export const FileUrlSchema = z.object({ presignedurl: z.string() }).passthrough()

// --- Figure image URL (GET student/figure_url) ---
export const FigureUrlSchema = z
  .object({ url: z.string(), caption: z.string().nullable().optional() })
  .passthrough()

// --- Module progress (GET student/module_progress) — lenient; refined Phase 5 ---
export const ModuleProgressSchema = z
  .object({
    module_score: z.number().nullable().optional(),
  })
  .passthrough()

/** @typedef {z.infer<typeof CourseSchema>} Course */
/** @typedef {z.infer<typeof CoursePageRowSchema>} CoursePageRow */
/** @typedef {z.infer<typeof SessionSchema>} Session */
/** @typedef {z.infer<typeof MessageSchema>} Message */
/** @typedef {z.infer<typeof ModuleFileSchema>} ModuleFile */
/** @typedef {z.infer<typeof ModuleProgressSchema>} ModuleProgress */
