import { z } from "zod"

// Runtime API contracts for the admin slice (Phase 7). Derived from the fields
// the UI consumes; `.passthrough()` keeps extra backend fields. Lenient by design.

// --- Instructors (GET admin/instructors, GET admin/courseInstructors) ---
// first/last name are null until the invited user signs up.
export const AdminInstructorSchema = z
  .object({
    user_email: z.string(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
  })
  .passthrough()
export const AdminInstructorsSchema = z.array(AdminInstructorSchema)

// --- Courses (GET admin/courses) — full Courses row ---
export const AdminCourseSchema = z
  .object({
    course_id: z.string(),
    course_name: z.string(),
    course_department: z.string(),
    course_number: z.union([z.string(), z.number()]),
    course_access_code: z.string().nullable().optional(),
    course_student_access: z.boolean().nullable().optional(),
    system_prompt: z.string().nullable().optional(),
  })
  .passthrough()
export const AdminCoursesSchema = z.array(AdminCourseSchema)

// --- Courses an instructor is assigned to (GET admin/instructorCourses) ---
export const InstructorCourseSchema = z
  .object({
    course_id: z.string(),
    course_name: z.string().nullable().optional(),
    course_department: z.string().nullable().optional(),
    course_number: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough()
export const InstructorCoursesSchema = z.array(InstructorCourseSchema)

// --- Created course (POST admin/create_course RETURNING *) ---
export const CreatedCourseSchema = z.object({ course_id: z.string() }).passthrough()

/** @typedef {z.infer<typeof AdminInstructorSchema>} AdminInstructor */
/** @typedef {z.infer<typeof AdminCourseSchema>} AdminCourse */
/** @typedef {z.infer<typeof InstructorCourseSchema>} InstructorAssignedCourse */
