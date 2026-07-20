import { useMutation, useQueryClient } from "@tanstack/react-query"
import { http } from "../http"
import { queryKeys } from "../queryKeys"

/**
 * Join a course by access code (POST student/enroll_student). Invalidates the
 * course list so the newly joined course appears. A bad/duplicate code surfaces
 * as an error the caller renders inline (join modal), not a silent failure.
 */
export function useEnrollCourse() {
  const qc = useQueryClient()
  return useMutation({
    // Enrollment errors (bad/duplicate code) are shown inline in the join modal,
    // so opt out of the global error toast.
    meta: { suppressGlobalError: true },
    mutationFn: async (accessCode) => {
      const { email } = await http.getAuth()
      return http.post("student/enroll_student", {
        student_email: email,
        course_access_code: accessCode,
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.courses.all }),
  })
}
