import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { InstructorCoursesSchema, CoursePromptSchema } from "../schemas/instructor"

/**
 * The instructor's own courses (GET instructor/courses). This is the management
 * list — distinct from the student `useCourses` list and from
 * `useCourses({ asInstructor: true })` (an instructor previewing AS a student).
 */
export function useInstructorCourses() {
  return useQuery({
    queryKey: queryKeys.instructor.courses,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("instructor/courses", { email })
      return parseWith(InstructorCoursesSchema, data ?? [], "instructor courses")
    },
  })
}

/**
 * Toggle a course Active/Inactive (POST instructor/updateCourseAccess → B7).
 * Flips `Courses.course_student_access` for a course the instructor teaches
 * (server-side ownership-checked). Optimistic: the instructor course list (which
 * feeds the course-detail header + the list badge) updates immediately and rolls
 * back on error.
 * @param {string} courseId
 */
export function useUpdateInstructorCourseAccess(courseId) {
  const qc = useQueryClient()
  const key = queryKeys.instructor.courses
  return useMutation({
    mutationFn: async (access) =>
      http.post("instructor/updateCourseAccess", { course_id: courseId, access: String(access) }),
    onMutate: async (access) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData(key)
      qc.setQueryData(key, (old) =>
        Array.isArray(old)
          ? old.map((c) => (c.course_id === courseId ? { ...c, course_student_access: access } : c))
          : old
      )
      return { previous }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}

/**
 * Delete a course the instructor teaches (DELETE instructor/delete_course → B7,
 * server-side ownership-checked; DB cascade + orphanCleanup backstop). Invalidates
 * the instructor course list on success.
 * @param {string} courseId
 */
export function useDeleteInstructorCourse(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => http.del("instructor/delete_course", { course_id: courseId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.instructor.courses }),
  })
}

/**
 * Course system prompt + model + stored conflict metadata (GET
 * instructor/get_prompt). Consumed by the Settings tab AND the course-shell tab
 * dot (an unresolved prompt conflict flags the Settings tab). Cheap + stable, so
 * it's shared rather than fetched twice.
 * @param {string} courseId
 */
export function useCoursePrompt(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.prompt(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/get_prompt", { course_id: courseId })
      return parseWith(CoursePromptSchema, data, "course prompt")
    },
  })
}
