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
 * `{ courseName, department, number, accessCode, active, systemPrompt, instructorEmails }`.
 */
export function useCreateCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      courseName,
      department,
      number,
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
