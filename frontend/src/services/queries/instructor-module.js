import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import {
  CourseFilesSchema,
  ModuleFileReferencesSchema,
  ModuleAllFilesSchema,
} from "../schemas/instructor"
import { cleanFileName, removeFileExtension, getFileType } from "@/utils/fileHelpers"

/** Flatten the get_all_files `document_files` map into a simple file array. */
function flattenModuleFiles(data) {
  const docs = data?.document_files || {}
  return Object.entries(docs).map(([fileName, info]) => {
    let meta = info?.metadata
    if (typeof meta === "string") {
      try {
        meta = JSON.parse(meta)
      } catch {
        meta = {}
      }
    }
    return {
      fileName,
      file_id: meta?.file_id ?? null,
      fileType: getFileType(fileName),
      description: meta?.description ?? "",
    }
  })
}

/** All files across a course's modules (GET instructor/course_files) — the pool
 *  for cross-module reference selection in the wizard/editor. */
export function useCourseFiles(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.courseFiles(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/course_files", { course_id: courseId })
      return parseWith(CourseFilesSchema, data ?? [], "course files")
    },
  })
}

/** File-ids referenced by a module (GET instructor/module_file_references). */
export function useModuleReferences(moduleId) {
  return useQuery({
    queryKey: queryKeys.instructor.moduleRefs(moduleId),
    enabled: Boolean(moduleId),
    queryFn: async () => {
      const data = await http.get("instructor/module_file_references", { module_id: moduleId })
      return parseWith(ModuleFileReferencesSchema, data ?? [], "module references")
    },
  })
}

/**
 * Finalize a reserved draft module (POST instructor/finalize_module) then persist
 * its cross-module references (PUT instructor/module_file_references). Sets the
 * module active. Errors are kept off the global error handler so the wizard owns
 * the specific 400 (duplicate name) / 409 (files still processing) cases inline
 * (the inline surface is a follow-up).
 * Variables: `{ moduleId, conceptId, moduleName, moduleNumber, modulePrompt, keyTopics,
 * referencedFileIds, fileDescriptions }` where `fileDescriptions` is `[{ fileName, description }]`.
 */
export function useFinalizeModule(courseId) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: async ({
      moduleId,
      conceptId,
      moduleName,
      moduleNumber,
      modulePrompt,
      keyTopics,
      referencedFileIds = [],
      fileDescriptions = [],
    }) => {
      const { email } = await http.getAuth()
      const updated = await http.post(
        "instructor/finalize_module",
        {
          module_id: moduleId,
          course_id: courseId,
          concept_id: conceptId,
          module_name: moduleName,
          module_number: moduleNumber,
          instructor_email: email,
        },
        { module_prompt: modulePrompt, key_topics: keyTopics?.length ? keyTopics : null }
      )
      await http.put(
        "instructor/module_file_references",
        { module_id: moduleId },
        { referenced_file_ids: referencedFileIds }
      )
      // Persist per-file descriptions (PUT instructor/update_metadata merges the
      // description into each file's metadata, preserving topic_extraction).
      // Best-effort: ingestion has finished by Publish, and an optional
      // description must not fail module creation.
      if (fileDescriptions.length) {
        await Promise.allSettled(
          fileDescriptions.map(({ fileName, description }) =>
            http.put(
              "instructor/update_metadata",
              {
                module_id: moduleId,
                filename: cleanFileName(removeFileExtension(fileName)),
                filetype: getFileType(fileName),
              },
              { metadata: description }
            )
          )
        )
      }
      return updated
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.instructor.modules(courseId) })
    },
  })
}

/** Existing files attached to a module (GET instructor/get_all_files), flattened.
 *  Named distinctly from the student `useModuleFiles` (GET student/files). */
export function useModuleAllFiles(courseId, moduleId, moduleName) {
  return useQuery({
    queryKey: queryKeys.instructor.moduleFiles(courseId, moduleId),
    enabled: Boolean(courseId && moduleId && moduleName),
    queryFn: async () => {
      const data = await http.get("instructor/get_all_files", {
        course_id: courseId,
        module_id: moduleId,
        module_name: moduleName,
      })
      const parsed = parseWith(ModuleAllFilesSchema, data ?? {}, "module files")
      return flattenModuleFiles(parsed)
    },
  })
}

/**
 * Save an existing module (PUT instructor/edit_module) + delete removed files +
 * persist references. Errors are kept off the global error handler so the editor
 * owns the 400 duplicate-name case inline (the inline surface is a follow-up).
 * Variables:
 * `{ moduleId, conceptId, moduleName, modulePrompt, keyTopics, referencedFileIds, removedFiles }`.
 */
export function useEditModule(courseId) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: async ({
      moduleId,
      conceptId,
      moduleName,
      modulePrompt,
      keyTopics,
      referencedFileIds = [],
      removedFiles = [],
    }) => {
      const { email } = await http.getAuth()
      await http.put(
        "instructor/edit_module",
        { module_id: moduleId, instructor_email: email, concept_id: conceptId },
        { module_name: moduleName, module_prompt: modulePrompt, key_topics: keyTopics }
      )
      await Promise.all(
        removedFiles.map((fileName) =>
          http.del("instructor/delete_file", {
            course_id: courseId,
            module_id: moduleId,
            module_name: moduleName,
            file_type: getFileType(fileName),
            file_name: cleanFileName(removeFileExtension(fileName)),
          })
        )
      )
      await http.put(
        "instructor/module_file_references",
        { module_id: moduleId },
        { referenced_file_ids: referencedFileIds }
      )
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.instructor.modules(courseId) })
      qc.invalidateQueries({ queryKey: queryKeys.instructor.moduleFiles(courseId, vars.moduleId) })
      qc.invalidateQueries({ queryKey: queryKeys.instructor.moduleRefs(vars.moduleId) })
    },
  })
}
