import apiClient from "./api";

/**
 * Best-effort, once-per-browser-session "session start" beacon.
 *
 * Fires `POST /student/session_start` so the backend records a `'login'`
 * engagement row. Device type, OS, and browser are parsed server-side from the
 * User-Agent header (coarse buckets only) and the identity comes from the
 * authorizer, so the client sends nothing. Called from `AuthContext` whenever a
 * session is established.
 *
 * Guarantees:
 * - Never throws and never blocks auth (fire-and-forget; errors swallowed). This
 *   is the sanctioned "call apiClient directly for non-cacheable best-effort
 *   writes" pattern, not server state — do not migrate it to TanStack Query.
 * - Fires at most once per browser session: a `sessionStorage` flag dedupes page
 *   refreshes and token refreshes within the same tab. The flag is set
 *   synchronously BEFORE the async POST, so React StrictMode's double-invoked
 *   effects (dev) and rapid re-entrant calls can't double-fire.
 * - If `sessionStorage` is unavailable (private mode / blocked), it skips rather
 *   than risk a beacon on every mount.
 */

const SESSION_FLAG = "aila:session_start_logged";

/**
 * @param {{ client?: typeof apiClient, storage?: Storage | null }} [deps]
 *   Injectable for testing; defaults to the real apiClient + window.sessionStorage.
 */
export function recordSessionStart({ client = apiClient, storage = getSessionStorage() } = {}) {
  try {
    if (!storage) return;
    if (storage.getItem(SESSION_FLAG)) return;
    // Set the flag before firing so a re-entrant call cannot double-post;
    // analytics is best-effort, so we deliberately don't retry on failure.
    storage.setItem(SESSION_FLAG, "1");
    Promise.resolve(client.post("student/session_start")).catch(() => {});
  } catch {
    // Analytics must never break auth — swallow storage/serialization errors.
  }
}

function getSessionStorage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}
