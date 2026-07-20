import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import {
  RosterSchema,
  AccessCodeSchema,
  GeneratedAccessCodeSchema,
  StudentMessagesSchema,
} from "../schemas/instructor"

/** Enrolled students for a course (GET instructor/view_students). */
export function useStudents(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.students(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/view_students", { course_id: courseId })
      return parseWith(RosterSchema, data ?? [], "roster")
    },
  })
}

/**
 * Course access code (GET instructor/get_access_code), normalized to a string.
 * NOTE the field-name mismatch with the regenerate endpoint (see below).
 */
export function useAccessCode(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.accessCode(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/get_access_code", { course_id: courseId })
      const parsed = parseWith(AccessCodeSchema, data ?? {}, "access code")
      return parsed.course_access_code ?? null
    },
  })
}

/**
 * Regenerate the course access code (PUT instructor/generate_access_code). The
 * response field is `access_code` here vs `course_access_code` on GET — both are
 * normalized to a plain string. Writes the new code straight into the cache so
 * the panel updates without a refetch.
 */
export function useRegenerateAccessCode(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const data = await http.put("instructor/generate_access_code", { course_id: courseId })
      const parsed = parseWith(GeneratedAccessCodeSchema, data ?? {}, "generated access code")
      return parsed.access_code ?? null
    },
    onSuccess: (code) => qc.setQueryData(queryKeys.instructor.accessCode(courseId), code),
  })
}

/** Unenroll a student from the course (DELETE instructor/delete_student). */
export function useDeleteStudent(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (userEmail) => {
      const { email } = await http.getAuth()
      await http.del("instructor/delete_student", {
        course_id: courseId,
        user_email: userEmail,
        instructor_email: email,
      })
      return userEmail
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.instructor.students(courseId) }),
  })
}

/**
 * A student's chat history across the course's modules (GET
 * instructor/student_modules_messages) — read-only viewer. Keyed by module name.
 * @param {string} courseId
 * @param {string} studentEmail
 */
export function useStudentMessages(courseId, studentEmail) {
  return useQuery({
    queryKey: queryKeys.instructor.studentMessages(courseId, studentEmail),
    enabled: Boolean(courseId && studentEmail),
    queryFn: async () => {
      const data = await http.get("instructor/student_modules_messages", {
        course_id: courseId,
        student_email: studentEmail,
      })
      return parseWith(StudentMessagesSchema, data ?? {}, "student messages")
    },
  })
}
