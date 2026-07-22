import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"

/**
 * Guards navigation away from a pane that has unsaved (staged) edits.
 *
 * A pane with staged changes calls `setDirty(true)` while dirty; navigation
 * triggers wrap their action in `runGuarded(action)`. When dirty, `runGuarded`
 * defers the action behind a "You have unsaved changes" confirm — proceeding
 * only if the user confirms. A `beforeunload` listener covers browser
 * refresh / tab-close / external navigation.
 *
 * The default context value is a **passthrough** (`setDirty` no-ops, `runGuarded`
 * runs the action immediately), so components using the hook work without a
 * provider (e.g. in unit tests) — guarding only kicks in under the provider.
 *
 * Why not React Router's `useBlocker`? It requires a data router
 * (`createBrowserRouter`), and this app uses the declarative `<BrowserRouter>`.
 */
const UnsavedChangesContext = createContext({
  setDirty: () => {},
  runGuarded: (action) => action(),
})

export function useUnsavedChanges() {
  return useContext(UnsavedChangesContext)
}

export function UnsavedChangesProvider({ children }) {
  const [dirty, setDirtyState] = useState(false)
  const dirtyRef = useRef(false)
  // Stored as a function via the updater form (setState treats a function arg as
  // an updater, so we wrap it): `pendingAction` is the deferred navigation.
  const [pendingAction, setPendingAction] = useState(null)

  const setDirty = useCallback((value) => {
    dirtyRef.current = Boolean(value)
    setDirtyState(Boolean(value))
  }, [])

  const runGuarded = useCallback((action) => {
    if (dirtyRef.current) {
      setPendingAction(() => action)
    } else {
      action()
    }
  }, [])

  // Browser-level guard (refresh / tab close / external navigation). The native
  // prompt's wording is fixed by the browser; this just arms it while dirty.
  useEffect(() => {
    if (!dirty) return undefined
    const handler = (event) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty])

  const proceed = () => {
    const action = pendingAction
    setPendingAction(null)
    // Leaving discards the staged edits — clear dirty so nothing re-prompts.
    setDirty(false)
    action?.()
  }

  return (
    <UnsavedChangesContext.Provider value={{ setDirty, runGuarded }}>
      {children}
      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => !open && setPendingAction(null)}
        title="Unsaved changes"
        description="You have unsaved changes. If you leave now, they'll be discarded."
        confirmLabel="Leave without saving"
        variant="danger"
        onConfirm={proceed}
      />
    </UnsavedChangesContext.Provider>
  )
}
