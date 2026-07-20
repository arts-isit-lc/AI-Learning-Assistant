import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { AdminInstructorsSchema, InstructorCoursesSchema } from "../schemas/admin"

/**
 * All instructors (GET admin/instructors). The `instructor_email` param is a
 * backend required-guard only — the query returns every user with the instructor
 * role (server-side `Users.roles[]`), not a filtered set.
 */
export function useAdminInstructors() {
  return useQuery({
    queryKey: queryKeys.admin.instructors,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("admin/instructors", { instructor_email: email })
      return parseWith(AdminInstructorsSchema, data ?? [], "admin instructors")
    },
  })
}

/**
 * Courses an instructor is assigned to (GET admin/instructorCourses). Named
 * distinctly from the instructor-side `useInstructorCourses` (an instructor's own
 * course list) to avoid a barrel export collision.
 * @param {string} instructorEmail
 */
export function useInstructorAssignedCourses(instructorEmail) {
  return useQuery({
    queryKey: queryKeys.admin.instructorCourses(instructorEmail),
    enabled: Boolean(instructorEmail),
    queryFn: async () => {
      const data = await http.get("admin/instructorCourses", { instructor_email: instructorEmail })
      return parseWith(InstructorCoursesSchema, data ?? [], "instructor assigned courses")
    },
  })
}

/** Add/create an instructor by email (POST admin/elevate_instructor) — additive server-side. */
export function useElevateInstructor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (email) => http.post("admin/elevate_instructor", { email }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.instructors }),
  })
}

/**
 * Remove an instructor (POST admin/lower_instructor) — demotes (drops the
 * instructor role) and deletes their instructor enrolments. Not a hard delete.
 */
export function useLowerInstructor() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (email) => http.post("admin/lower_instructor", { email }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.instructors })
      qc.invalidateQueries({ queryKey: queryKeys.admin.courses })
    },
  })
}

/**
 * Replace the set of courses an instructor is assigned to (the legacy pattern:
 * delete ALL their instructor enrolments, then re-enroll the selected set).
 * Variables: an array of course_ids.
 * @param {string} instructorEmail
 */
export function useSetInstructorCourses(instructorEmail) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (courseIds) => {
      await http.del("admin/delete_instructor_enrolments", { instructor_email: instructorEmail })
      await Promise.all(
        courseIds.map((courseId) =>
          http.post("admin/enroll_instructor", {
            course_id: courseId,
            instructor_email: instructorEmail,
          })
        )
      )
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.admin.instructorCourses(instructorEmail) }),
  })
}
