import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { ConceptsSchema, InstructorModulesSchema } from "../schemas/instructor"

/** Concepts for a course (GET instructor/view_concepts). */
export function useConcepts(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.concepts(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/view_concepts", { course_id: courseId })
      return parseWith(ConceptsSchema, data ?? [], "concepts")
    },
  })
}

/** Modules for a course (GET instructor/view_modules) — grouped into the tree by concept. */
export function useModules(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.modules(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/view_modules", { course_id: courseId })
      return parseWith(InstructorModulesSchema, data ?? [], "modules")
    },
  })
}

/** Create a concept (POST instructor/create_concept). `nextNumber` = concepts.length + 1. */
export function useCreateConcept(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ conceptName, nextNumber }) =>
      http.post(
        "instructor/create_concept",
        { course_id: courseId, concept_number: nextNumber },
        { concept_name: conceptName }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.instructor.concepts(courseId) }),
  })
}

/** Rename a concept (PUT instructor/edit_concept), keeping its existing number. */
export function useRenameConcept(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ conceptId, conceptName, conceptNumber }) =>
      http.put(
        "instructor/edit_concept",
        { concept_id: conceptId, concept_number: conceptNumber },
        { concept_name: conceptName }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.instructor.concepts(courseId) }),
  })
}

/**
 * Delete a concept and cascade to its modules (client-orchestrated, matching the
 * legacy flow): delete each child module's S3 objects first, then the concept
 * (the DB `ON DELETE CASCADE` removes the module rows). Backend track B6 will
 * move this to a server-side mark-and-sweep; until then the frontend cascades.
 * Variables: `{ concept, modules }`.
 */
export function useDeleteConcept(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ concept, modules = [] }) => {
      await Promise.all(
        modules.map((m) =>
          http.del("instructor/delete_module_s3", {
            course_id: courseId,
            module_id: m.module_id,
            module_name: m.module_name,
          })
        )
      )
      await http.del("instructor/delete_concept", { concept_id: concept.concept_id })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.instructor.concepts(courseId) })
      qc.invalidateQueries({ queryKey: queryKeys.instructor.modules(courseId) })
    },
  })
}

/** Delete a single module (DELETE delete_module_s3 then delete_module). */
export function useDeleteModule(courseId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (module) => {
      await http.del("instructor/delete_module_s3", {
        course_id: courseId,
        module_id: module.module_id,
        module_name: module.module_name,
      })
      await http.del("instructor/delete_module", { module_id: module.module_id })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.instructor.modules(courseId) }),
  })
}

/**
 * Persist a new concept order (PUT instructor/edit_concept per row with its new
 * `concept_number`). Optimistic: the concept cache reorders immediately and
 * rolls back on error. Variables: the concepts array in the new order.
 */
export function useReorderConcepts(courseId) {
  const qc = useQueryClient()
  const key = queryKeys.instructor.concepts(courseId)
  return useMutation({
    mutationFn: async (ordered) => {
      await Promise.all(
        ordered.map((c, i) =>
          http.put(
            "instructor/edit_concept",
            { concept_id: c.concept_id, concept_number: i + 1 },
            { concept_name: c.concept_name, concept_number: i + 1 }
          )
        )
      )
    },
    onMutate: async (ordered) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData(key)
      qc.setQueryData(
        key,
        ordered.map((c, i) => ({ ...c, concept_number: i + 1 }))
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
 * Persist a new module order within a concept (PUT instructor/reorder_module per
 * row). module_number is assigned sequentially within the concept (tree-native
 * ordering). Optimistic update of the flat module cache + rollback. Variables:
 * the reordered module array for one concept.
 */
export function useReorderModules(courseId) {
  const qc = useQueryClient()
  const key = queryKeys.instructor.modules(courseId)
  return useMutation({
    mutationFn: async (ordered) => {
      const { email } = await http.getAuth()
      await Promise.all(
        ordered.map((m, i) =>
          http.put(
            "instructor/reorder_module",
            { module_id: m.module_id, module_number: i + 1, instructor_email: email },
            { module_name: m.module_name }
          )
        )
      )
    },
    onMutate: async (ordered) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData(key)
      const numberById = new Map(ordered.map((m, i) => [m.module_id, i + 1]))
      qc.setQueryData(key, (old) =>
        Array.isArray(old)
          ? old.map((m) =>
              numberById.has(m.module_id) ? { ...m, module_number: numberById.get(m.module_id) } : m
            )
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
