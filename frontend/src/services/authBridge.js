/**
 * Decouples the (React-free) data layer from auth + navigation.
 *
 * The `AuthProvider` registers a handler (its `signOut`); the HTTP layer calls
 * `notifyUnauthorized()` when a 401 can't be recovered by a token refresh.
 * Clearing auth makes `RequireAuth` redirect to /login, so no direct navigation
 * is needed here. Falls back to a hard redirect if nothing is registered.
 */
let unauthorizedHandler = null

/** @param {() => void} fn */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn
}

export function notifyUnauthorized() {
  if (typeof unauthorizedHandler === "function") {
    unauthorizedHandler()
  } else if (typeof window !== "undefined") {
    window.location.assign("/login")
  }
}

/** Test helper — clears the registered handler. */
export function __resetAuthBridge() {
  unauthorizedHandler = null
}
