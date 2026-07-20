import { useQuery } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { ModuleProgressSchema } from "../schemas/student"

/**
 * Student's progress on a module (GET student/module_progress). Progress changes
 * during the chat as the LLM updates the score, so this is always refetched
 * (staleTime 0) — a stale badge is the exact bug this feature fixes.
 * @param {string} courseId
 * @param {string} moduleId
 * @param {{ enabled?: boolean }} [opts]
 */
export function useModuleProgress(courseId, moduleId, { enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.modules.progress(courseId, moduleId),
    enabled: Boolean(courseId && moduleId) && enabled,
    staleTime: 0,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("student/module_progress", {
        email,
        course_id: courseId,
        module_id: moduleId,
      })
      return parseWith(ModuleProgressSchema, data, "module progress")
    },
  })
}
