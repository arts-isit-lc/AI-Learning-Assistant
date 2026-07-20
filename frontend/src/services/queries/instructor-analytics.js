import { useQuery } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { AnalyticsSchema } from "../schemas/instructor"

/**
 * Per-module analytics for the Insights tab (GET instructor/analytics): message
 * count, perfect-score percentage, and access count per module. The engagement/
 * reach/clear-data metrics (B1) are deferred, so this is the single read Insights
 * ports from the legacy chart.
 * @param {string} courseId
 */
export function useAnalytics(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.analytics(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const data = await http.get("instructor/analytics", { course_id: courseId })
      return parseWith(AnalyticsSchema, data ?? [], "analytics")
    },
  })
}
