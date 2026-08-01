import { QueryClient, QueryCache, MutationCache } from "@tanstack/react-query"

/**
 * Centralized error-observability seam. OCELIA surfaces user-facing errors
 * inline at the point of action (Alert / ErrorState / in-dialog message), never
 * as a transient notification — so this deliberately shows the user nothing. It
 * keeps a console breadcrumb (and a single spot to wire telemetry later) so the
 * failures that would otherwise be silent stay diagnosable. Skips:
 * - inline errors (403 forbidden, expired-session redirect) — screens render those;
 * - anything a query/mutation opts out of via `meta.suppressGlobalError` (e.g.
 *   forms/dialogs that show the error in place).
 * Fires only after a query's retries are exhausted.
 */
function handleGlobalError(error, meta) {
  if (error?.inline) return
  if (meta?.suppressGlobalError) return
  // TODO(telemetry): forward to the error-reporting sink once one is wired.
  console.error("[query]", error)
}

/**
 * Create the OCELIA QueryClient with the §10 policy:
 * - GET queries retry twice with exponential backoff, but never retry a
 *   definitive client error (4xx);
 * - mutations never auto-retry (avoid duplicate writes) — screens offer a
 *   user-triggered retry;
 * - default networkMode ("online") pauses when offline and refetches on
 *   reconnect (drives the OfflineBanner).
 */
export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => handleGlobalError(error, query?.meta),
    }),
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => handleGlobalError(error, mutation?.meta),
    }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          const status = error?.status
          if (typeof status === "number" && status >= 400 && status < 500) return false
          return failureCount < 2
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30000),
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
