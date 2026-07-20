import { fetchAuthSession } from "aws-amplify/auth"
import apiClient from "./api"
import { ApiError } from "./apiError"
import { notifyUnauthorized } from "./authBridge"

/**
 * Normalize a thrown error from `apiClient` into an `ApiError`. 403 becomes an
 * inline error (rendered in place, never toasted).
 * @param {any} error
 * @returns {ApiError}
 */
function normalize(error) {
  if (error instanceof ApiError) return error
  const status = error?.status ?? null
  return new ApiError(error?.message || "Request failed", {
    status,
    inline: status === 403,
    cause: error,
  })
}

/**
 * Run an `apiClient` call through the OCELIA auth/error interceptor:
 * - **401** → force a token refresh and retry once; if it still fails, clear
 *   auth (→ redirect to /login via `RequireAuth`) and throw a silent inline error.
 * - **403** → throw an inline `ApiError` (screen renders it; no toast, no redirect).
 * - anything else → throw a normalized `ApiError` (the QueryClient toasts it).
 *
 * Lives in this data-layer wrapper, NOT in the shared `api.js`, so legacy pages
 * keep their existing behavior.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
export async function withAuth(call) {
  try {
    return await call()
  } catch (err) {
    const apiErr = normalize(err)
    if (apiErr.status !== 401) throw apiErr

    // Attempt a silent refresh, then retry the call exactly once.
    try {
      await fetchAuthSession({ forceRefresh: true })
    } catch {
      notifyUnauthorized()
      throw new ApiError("Your session has expired. Please sign in again.", {
        status: 401,
        inline: true,
      })
    }

    try {
      return await call()
    } catch (retryErr) {
      const retryApiErr = normalize(retryErr)
      if (retryApiErr.status === 401) {
        notifyUnauthorized()
        throw new ApiError("Your session has expired. Please sign in again.", {
          status: 401,
          inline: true,
        })
      }
      throw retryApiErr
    }
  }
}

/** Verb helpers used by query/mutation functions (all go through `withAuth`). */
export const http = {
  get: (path, params) => withAuth(() => apiClient.get(path, params)),
  post: (path, params, body) => withAuth(() => apiClient.post(path, params, body)),
  put: (path, params, body) => withAuth(() => apiClient.put(path, params, body)),
  del: (path, params) => withAuth(() => apiClient.delete(path, params)),
  getAuth: () => apiClient.getAuth(),
}

/**
 * Validate a response against a Zod schema (the runtime API contract). Strict
 * in dev — throws on drift so contract breaks surface immediately in tests/dev;
 * safe in prod — logs and returns the raw data so a minor backend addition
 * never blanks the UI.
 *
 * @template T
 * @param {import("zod").ZodType<T>} schema
 * @param {unknown} data
 * @param {string} [label]
 * @returns {T}
 */
export function parseWith(schema, data, label = "response") {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  if (import.meta.env.DEV) {
    console.error(`[contract] ${label} failed validation`, result.error.issues, data)
    throw new ApiError(`Contract validation failed for "${label}"`, {
      status: null,
      cause: result.error,
    })
  }
  console.warn(`[contract] ${label} drifted from its schema; using raw data`, result.error.issues)
  return data
}
