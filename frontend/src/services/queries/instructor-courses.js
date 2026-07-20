import { useQuery } from "@tanstack/react-query"
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
