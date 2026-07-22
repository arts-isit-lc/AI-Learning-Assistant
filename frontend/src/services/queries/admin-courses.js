import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { AdminCoursesSchema, AdminInstructorsSchema, CreatedCourseSchema } from "../schemas/admin"

/** All courses (GET admin/courses). */
export function useAdminCourses() {
  return useQuery({
    queryKey: queryKeys.admin.courses,
    queryFn: async () => {
      const data = await http.get("admin/courses")
      return parseWith(AdminCoursesSchema, data ?? [], "admin courses")
    },
  })
}

/** Instructors assigned to a course (GET admin/courseInstructors). */
export function useCourseInstructors(courseId) {
  return useQuery({
    queryKey: queryKeys.admin.courseInstructors(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("admin/courseInstructors", { course_id: courseId })
      return parseWith(AdminInstructorsSchema, data ?? [], "course instructors")
    },
  })
}

/**
 * Create a course (POST admin/create_course — course fields as query params +
 * `{ system_prompt }` body) then enroll the selected instructors. `active` is
 * sent as-is; `apiClient` stringifies it to "true"/"false" for the backend.
 * Returns the created `{ course_id }`. Variables:
 * `{ courseName, department, number, term, accessCode, active, systemPrompt, instructorEmails }`.
 */
export function useCreateCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      courseName,
      department,
      number,
      term,
      accessCode,
      active,
      systemPrompt,
      instructorEmails = [],
    }) => {
      const created = await http.post(
        "admin/create_course",
        {
          course_name: courseName,
          course_department: department,
          course_number: number,
          term,
          course_access_code: accessCode,
          course_student_access: active,
        },
        { system_prompt: systemPrompt }
      )
      const parsed = parseWith(CreatedCourseSchema, created, "created course")
      await Promise.all(
        instructorEmails.map((email) =>
          http.post("admin/enroll_instructor", {
            course_id: parsed.course_id,
            instructor_email: email,
          })
        )
      )
      return parsed
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.courses }),
  })
}

/** Delete a course (DELETE admin/delete_course; cascades server-side). */
export function useDeleteCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (courseId) => http.del("admin/delete_course", { course_id: courseId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.courses }),
  })
}

/**
 * Toggle course student access (Active/Inactive) — POST admin/updateCourseAccess.
 * Variables: `{ courseId, access: boolean }`.
 */
export function useUpdateCourseAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ courseId, access }) =>
      http.post("admin/updateCourseAccess", { course_id: courseId, access }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.courses }),
  })
}

/**
 * Replace the set of instructors assigned to a course (delete-all-then-re-enroll).
 * Variables: an array of instructor emails.
 * @param {string} courseId
 */
export function useSetCourseInstructors(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (instructorEmails) => {
      await http.del("admin/delete_course_instructor_enrolments", { course_id: courseId })
      await Promise.all(
        instructorEmails.map((email) =>
          http.post("admin/enroll_instructor", { course_id: courseId, instructor_email: email })
        )
      )
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.admin.courseInstructors(courseId) }),
  })
}

/**
 * Enroll a single instructor in a course (POST admin/enroll_instructor). Used by
 * the detail-pane Add action; additive (ON CONFLICT server-side) so it never
 * disturbs other enrolments or their per-instructor access flags. Variables:
 * `{ courseId, instructorEmail }`.
 */
export function useEnrollInstructor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ courseId, instructorEmail }) =>
      http.post("admin/enroll_instructor", {
        course_id: courseId,
        instructor_email: instructorEmail,
      }),
    onSuccess: (_data, { courseId, instructorEmail }) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.courseInstructors(courseId) })
      qc.invalidateQueries({ queryKey: queryKeys.admin.instructorCourses(instructorEmail) })
    },
  })
}

/**
 * Remove a single instructor from a course (DELETE admin/unenroll_instructor).
 * Single-pair removal — leaves other instructors' enrolments (and their access
 * flags) untouched, unlike the delete-all-then-re-enroll set mutation. Variables:
 * `{ courseId, instructorEmail }`.
 */
export function useUnenrollInstructor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ courseId, instructorEmail }) =>
      http.del("admin/unenroll_instructor", {
        course_id: courseId,
        instructor_email: instructorEmail,
      }),
    onSuccess: (_data, { courseId, instructorEmail }) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.courseInstructors(courseId) })
      qc.invalidateQueries({ queryKey: queryKeys.admin.instructorCourses(instructorEmail) })
    },
  })
}

/**
 * Set the per-instructor OCELIA access flag on a course enrolment (POST
 * admin/updateInstructorAccess, backend track B4). Invalidates both the
 * course→instructors and instructor→courses reads (both carry `access_enabled`).
 * Variables: `{ courseId, instructorEmail, access: boolean }`.
 */
export function useUpdateInstructorAccess() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ courseId, instructorEmail, access }) =>
      http.post("admin/updateInstructorAccess", {
        course_id: courseId,
        instructor_email: instructorEmail,
        access,
      }),
    onSuccess: (_data, { courseId, instructorEmail }) => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.courseInstructors(courseId) })
      qc.invalidateQueries({ queryKey: queryKeys.admin.instructorCourses(instructorEmail) })
    },
  })
}

/**
 * Duplicate a course (POST admin/duplicate_course, backend track B2). Clones the
 * course row + the concept/module outline server-side; NOT files, embeddings,
 * enrolments, or student data. `active` is sent as-is (apiClient stringifies it
 * to "true"/"false"). `term` is optional and only sent when non-empty — omitting
 * it makes the backend keep the source course's term (COALESCE), so the
 * course-detail Duplicate dialog (which sends no term) is unaffected. Returns the
 * new `{ course_id }`. Variables:
 * `{ sourceCourseId, courseName, department, number, term?, accessCode, active, systemPrompt }`.
 */
export function useDuplicateCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      sourceCourseId,
      courseName,
      department,
      number,
      term,
      accessCode,
      active,
      systemPrompt,
    }) => {
      const created = await http.post(
        "admin/duplicate_course",
        {
          source_course_id: sourceCourseId,
          course_name: courseName,
          course_department: department,
          course_number: number,
          ...(term ? { term } : {}),
          course_access_code: accessCode,
          course_student_access: active,
        },
        { system_prompt: systemPrompt }
      )
      return parseWith(CreatedCourseSchema, created, "duplicated course")
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.courses }),
  })
}
