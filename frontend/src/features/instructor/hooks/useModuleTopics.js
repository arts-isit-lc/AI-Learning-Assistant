import { useCallback, useState } from "react"
import apiClient from "@/services/api"

/**
 * Auto key-topic generation for a module (POST instructor/generate_topics).
 * Imperative (fires after files finish processing), so it's a feature hook. The
 * caller merges `result.topics` into the existing key topics and handles the
 * status values ("processing" | "no_files" | "error" | success).
 *
 * @param {string} moduleId
 */
export function useModuleTopics(moduleId) {
  const [isGenerating, setIsGenerating] = useState(false)

  const generate = useCallback(async () => {
    if (!moduleId) return { status: "no_module" }
    setIsGenerating(true)
    try {
      return await apiClient.post("instructor/generate_topics", { module_id: moduleId })
    } finally {
      setIsGenerating(false)
    }
  }, [moduleId])

  return { generate, isGenerating }
}
