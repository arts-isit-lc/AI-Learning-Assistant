import { useQuery } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { ModuleFilesSchema, FileUrlSchema, FigureUrlSchema } from "../schemas/student"

/** Files attached to a module (GET student/files). Static for the session. */
export function useModuleFiles(courseId, moduleId) {
  return useQuery({
    queryKey: queryKeys.modules.files(courseId, moduleId),
    enabled: Boolean(courseId && moduleId),
    staleTime: Infinity,
    queryFn: async () => {
      const data = await http.get("student/files", {
        course_id: courseId,
        module_id: moduleId,
      })
      return parseWith(ModuleFilesSchema, data ?? [], "module files")
    },
  })
}

/**
 * Presigned URL for a file (GET student/file_url). Presigned URLs are
 * short-lived, so this is fetched on demand and expires from cache quickly.
 * @param {string} fileId
 * @param {{ enabled?: boolean }} [opts]
 */
export function useFileUrl(fileId, { enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.files.url(fileId),
    enabled: Boolean(fileId) && enabled,
    staleTime: 4 * 60_000,
    queryFn: async () => {
      const data = await http.get("student/file_url", { file_id: fileId })
      return parseWith(FileUrlSchema, data, "file url")
    },
  })
}

/**
 * Presigned URL + caption for a figure image (GET student/figure_url). Cached
 * long-ish (presigned URLs live ~1h); Query dedupes concurrent mounts of the
 * same figure in one message.
 * @param {string} figureId
 * @param {{ enabled?: boolean }} [opts]
 */
export function useFigureUrl(figureId, { enabled = true } = {}) {
  return useQuery({
    queryKey: ["figures", figureId, "url"],
    enabled: Boolean(figureId) && enabled,
    staleTime: 50 * 60_000,
    queryFn: async () => {
      const data = await http.get("student/figure_url", { figure_id: figureId })
      return parseWith(FigureUrlSchema, data, "figure url")
    },
  })
}
