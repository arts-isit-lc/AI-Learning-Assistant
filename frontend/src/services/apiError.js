/**
 * Normalized error thrown by the OCELIA data layer. Carries the HTTP `status`
 * and an `inline` flag: inline errors (e.g. 403 forbidden, expired session) are
 * handled in place by the consuming screen / redirect and are NOT passed to the
 * global error handler (plan §10).
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number|null, inline?: boolean, cause?: unknown }} [opts]
   */
  constructor(message, { status = null, inline = false, cause } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.inline = inline
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Map an error to a short, user-facing message for an inline error surface
 * (an `Alert`, the `ErrorState` component, or a confirm-dialog message). Pass
 * `overrides` to specialize copy for specific status codes (e.g.
 * `{ 400: "A module with this name already exists." }`); any status not in the
 * map falls through to the shared default. Keeping copy in this one function
 * (rather than a per-form mapper) is the convention.
 * @param {{ status?: number|null, message?: string }} error
 * @param {Record<number, string>} [overrides]
 * @returns {string}
 */
export function toUserMessage(error, overrides = {}) {
  const status = error?.status
  if (status != null && overrides[status]) return overrides[status]
  if (status === 404) return "We couldn't find that."
  if (status === 429) return "Too many requests \u2014 please slow down and try again."
  if (typeof status === "number" && status >= 500) {
    return "Something went wrong on our end. Please try again."
  }
  if (status == null) return "Network problem \u2014 check your connection and try again."
  return error?.message || "Something went wrong."
}
