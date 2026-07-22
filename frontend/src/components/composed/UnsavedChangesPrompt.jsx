import { useEffect } from "react"
import { useBlocker } from "react-router-dom"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"

/**
 * Drop-in unsaved-changes navigation guard for any form. While `when` is true it:
 *  - intercepts in-app navigation — `<Link>`, `navigate()`, **and the browser
 *    back/forward buttons** — via React Router's `useBlocker`, showing a confirm
 *    before leaving; and
 *  - arms a `beforeunload` prompt for browser refresh / tab-close / external
 *    navigation (which `useBlocker` does not cover).
 *
 * Requires a data router (`createBrowserRouter` + `RouterProvider`) — which the
 * app uses. Render it inside a form: `<UnsavedChangesPrompt when={isDirty} />`.
 *
 * `onProceed` is an optional cleanup hook run when the user confirms leaving
 * (before the navigation proceeds) — e.g. the create wizard releases its
 * reserved draft module so an abandoned draft isn't orphaned.
 *
 * @param {{ when: boolean, onProceed?: () => void }} props `when` = there are
 *   unsaved changes; `onProceed` = optional cleanup on confirmed leave.
 */
export function UnsavedChangesPrompt({ when, onProceed }) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      Boolean(when) && currentLocation.pathname !== nextLocation.pathname
  )

  // Browser-level guard (refresh / tab close / external nav). The native
  // prompt's wording is fixed by the browser; this just arms it while dirty.
  useEffect(() => {
    if (!when) return undefined
    const handler = (event) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [when])

  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset()
      }}
      title="Unsaved changes"
      description="You have unsaved changes. If you leave now, they'll be discarded."
      confirmLabel="Leave without saving"
      variant="danger"
      onConfirm={() => {
        onProceed?.()
        blocker.proceed?.()
      }}
    />
  )
}
