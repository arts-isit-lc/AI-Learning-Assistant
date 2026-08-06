import { useEffect, useState } from "react"
import { useRouteError } from "react-router-dom"
import LoadingScreen from "./LoadingScreen"
import { ErrorState } from "@/components/composed/ErrorState"

/**
 * True when `error` is a failed dynamic import — the "stale chunk" case: after a
 * redeploy, a tab still holding the previous build's module graph requests an
 * old content-hashed chunk URL (e.g. /assets/InstructorCourseList-<oldhash>.js)
 * that no longer exists, so the fetch 404s. The message wording varies by
 * engine: Chromium "Failed to fetch dynamically imported module", Firefox
 * "error loading dynamically imported module", Safari "Importing a module script
 * failed". Exported for unit testing.
 */
export function isChunkLoadError(error) {
  const message = (error && (error.message || String(error))) || ""
  return (
    /dynamically imported module/i.test(message) ||
    /importing a module script failed/i.test(message) ||
    /error loading dynamically imported/i.test(message)
  )
}

const RELOAD_KEY = "ocelia:chunk-reload-at"
const RELOAD_WINDOW_MS = 10_000

/**
 * Reload at most once per RELOAD_WINDOW_MS (tracked per-tab in sessionStorage) so
 * a genuinely missing chunk (offline, or a broken/partial deploy) can't loop: a
 * second stale-chunk error inside the window falls through to the error screen
 * instead of reloading again. A later version skew (window elapsed) earns a
 * fresh single reload. Returns false if sessionStorage is unavailable, so a
 * blocked store never risks an infinite reload.
 */
function shouldReloadForChunkError() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0
    if (Date.now() - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    return true
  } catch {
    return false
  }
}

/**
 * Root route `errorElement`. On a stale-chunk dynamic-import failure it reloads
 * the page once — pulling the fresh index.html and the current chunk hashes — so
 * the user recovers seamlessly instead of hitting React Router's default crash
 * screen. Any other error (or a repeat chunk error within the reload window)
 * renders a real, actionable error screen. Reloading is decided in an effect
 * (not during render) so the sessionStorage guard stays side-effect-free under
 * StrictMode's double-render.
 */
export function RouteError() {
  const error = useRouteError()
  const isChunk = isChunkLoadError(error)
  // Optimistically show the spinner for a chunk error; the effect either reloads
  // or flips this off (repeat within the window) to reveal the error screen.
  const [reloading, setReloading] = useState(isChunk)

  useEffect(() => {
    // Always log so a broken deploy or a genuine app error stays visible to devs.
    if (error) console.error("Route error:", error)
  }, [error])

  useEffect(() => {
    if (!isChunk) return
    if (shouldReloadForChunkError()) window.location.reload()
    else setReloading(false)
  }, [isChunk])

  // NOTE: the label must be a JS expression, not a plain JSX string attribute —
  // JSX does NOT interpret backslash escapes inside "..." attributes, so
  // label="...\u2026" would render the literal characters \u2026 on screen.
  if (isChunk && reloading) return <LoadingScreen label={"Updating to the latest version\u2026"} />

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <ErrorState
        title={isChunk ? "Couldn't load the latest version" : "Something went wrong"}
        description={
          isChunk
            ? "A newer version is available but couldn't be loaded automatically. Please reload the page."
            : "An unexpected error occurred. Reloading the page usually fixes it."
        }
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
        className="max-w-md border-solid"
      />
    </div>
  )
}

export default RouteError
