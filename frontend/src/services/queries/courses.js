import { useQuery } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { CoursesSchema, CoursePageSchema, CourseProgressSummarySchema } from "../schemas/student"

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

/**
 * Per-course completion summary for the home grid — percent + concepts
 * completed/total per enrolled course, aggregated server-side in ONE request
 * (`GET student/progress_summary`) instead of a course_page fetch per card.
 * Disabled in instructor preview mode (progress is student-enrolment scoped).
 * @param {{ asInstructor?: boolean }} [opts]
 */
export function useCourseProgressSummary({ asInstructor = false } = {}) {
  return useQuery({
    queryKey: queryKeys.courses.progressSummary(asInstructor),
    enabled: !asInstructor,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("student/progress_summary", { email })
      return parseWith(CourseProgressSummarySchema, data, "progress summary")
    },
  })
}

/** Concept → module rows for the student course page. */
export function useCoursePage(courseId, { enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.courses.page(courseId),
    enabled: Boolean(courseId) && enabled,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("student/course_page", { email, course_id: courseId })
      return parseWith(CoursePageSchema, data, "course_page")
    },
  })
}
