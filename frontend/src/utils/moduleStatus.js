/**
 * Derive a student's status for a module from its progress fields.
 *
 * Mirrors the Complete / In Progress / Incomplete thresholds used in
 * CourseView so new UI (e.g. the chat-page progress popover) stays in sync
 * with the course page's meaning:
 *   - module_score === 100  -> "complete"
 *   - last_accessed set      -> "in_progress"
 *   - otherwise              -> "incomplete"
 *
 * @param {{ module_score?: number|null, last_accessed?: string|null }} [progress]
 * @returns {"complete"|"in_progress"|"incomplete"}
 */
export function getModuleStatus({ module_score, last_accessed } = {}) {
  if (module_score === 100) return "complete";
  if (last_accessed) return "in_progress";
  return "incomplete";
}
