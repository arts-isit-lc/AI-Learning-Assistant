import { useQuery } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { CoursesSchema, CoursePageSchema } from "../schemas/student"

/**
 * Enrolled courses for the current student — or, when `asInstructor` is set, the
 * courses an instructor previews in student mode.
 * @param {{ asInstructor?: boolean }} [opts]
 */
export function useCourses({ asInstructor = false } = {}) {
  return useQuery({
    queryKey: queryKeys.courses.list(asInstructor),
    queryFn: async () => {
      const { email } = await http.getAuth()
      const path = asInstructor ? "instructor/student_course" : "student/course"
      const data = await http.get(path, { email })
      return parseWith(CoursesSchema, data, "courses")
    },
  })
}

/** Concept → module rows for the student course page. */
export function useCoursePage(courseId) {
  return useQuery({
    queryKey: queryKeys.courses.page(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("student/course_page", { email, course_id: courseId })
      return parseWith(CoursePageSchema, data, "course_page")
    },
  })
}
