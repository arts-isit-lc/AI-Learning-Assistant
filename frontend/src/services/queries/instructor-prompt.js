import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { PreviousPromptsSchema, ConflictReportSchema, CoursePromptSchema } from "../schemas/instructor"

/** Prompt version history (GET instructor/previous_prompts). */
export function usePreviousPrompts(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.previousPrompts(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("instructor/previous_prompts", {
        course_id: courseId,
        instructor_email: email,
      })
      return parseWith(PreviousPromptsSchema, data ?? [], "previous prompts")
    },
  })
}

/**
 * Validate a prompt for conflicts (POST instructor/validate_prompt). Used on
 * Save (course scope) and by the module editor/wizard (module scope). Errors are
 * suppressed from the global toast — the caller degrades gracefully (save is
 * still allowed if validation is unavailable, matching the legacy behavior).
 * Variables: `{ prompt, scope?: "course"|"module", moduleId? }`.
 */
export function useValidatePrompt(courseId) {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: async ({ prompt, scope = "course", moduleId }) => {
      const { email } = await http.getAuth()
      const body = { prompt, scope }
      if (moduleId) body.module_id = moduleId
      const data = await http.post(
        "instructor/validate_prompt",
        { course_id: courseId, instructor_email: email },
        body
      )
      return parseWith(ConflictReportSchema, data ?? {}, "prompt validation")
    },
  })
}

/**
 * Save the course prompt + model (PUT instructor/prompt). `conflictMetadata` is
 * the full report when overriding an unresolved conflict, else null (clean) —
 * this is what round-trips into get_prompt and drives the Settings tab dot.
 * Invalidates the prompt + history queries so the shell + history refresh.
 * Variables: `{ prompt, llmModelId, conflictMetadata }`.
 */
export function useSavePrompt(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ prompt, llmModelId, conflictMetadata }) => {
      const { email } = await http.getAuth()
      const data = await http.put(
        "instructor/prompt",
        { course_id: courseId, instructor_email: email },
        { prompt, llm_model_id: llmModelId, conflict_metadata: conflictMetadata ?? null }
      )
      return parseWith(CoursePromptSchema, data ?? {}, "saved prompt")
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.instructor.prompt(courseId) })
      qc.invalidateQueries({ queryKey: queryKeys.instructor.previousPrompts(courseId) })
    },
  })
}
