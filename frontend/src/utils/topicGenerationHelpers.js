/**
 * Determines whether auto-generation should be triggered.
 * @param {Object} trackedFiles - Map of fileId -> { status: string }
 * @returns {boolean} true when all files are terminal AND at least one is "complete"
 */
export function shouldAutoGenerate(trackedFiles) {
  const entries = Object.values(trackedFiles);
  if (entries.length === 0) return false;

  const terminalStatuses = ["complete", "failed", "timed_out"];
  const allTerminal = entries.every((f) => terminalStatuses.includes(f.status));
  const hasComplete = entries.some((f) => f.status === "complete");

  return allTerminal && hasComplete;
}

/**
 * Merges incoming topics into existing topics, skipping case-insensitive duplicates.
 * @param {string[]} existing - Current key topics
 * @param {string[]} incoming - New topics to merge
 * @returns {string[]} Combined list with no duplicates
 */
export function mergeTopics(existing, incoming) {
  const existingLower = new Set(existing.map((t) => t.toLowerCase().trim()));
  const toAdd = incoming.filter(
    (t) => t.trim() && !existingLower.has(t.toLowerCase().trim())
  );
  return [...existing, ...toAdd];
}

/**
 * Finds which incoming topics are duplicates of existing ones.
 * @param {string[]} existing - Current key topics
 * @param {string[]} incoming - Topics to check
 * @returns {Set<string>} Set of incoming topic strings that are duplicates (original casing)
 */
export function findDuplicates(existing, incoming) {
  const existingLower = new Set(existing.map((t) => t.toLowerCase().trim()));
  return new Set(
    incoming.filter((t) => existingLower.has(t.toLowerCase().trim()))
  );
}
