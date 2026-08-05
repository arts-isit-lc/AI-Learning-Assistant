import { useAuth } from "@/context/AuthContext"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useIdleTimer } from "./useIdleTimer"

// Session hardening defaults: sign out after 30 min of inactivity, warning the
// user 60s beforehand. Overridable via Vite env so ops can tune without a code
// change (falsy/NaN -> default).
const IDLE_TIMEOUT_MS = Number(import.meta.env.VITE_IDLE_TIMEOUT_MS) || 30 * 60 * 1000
const IDLE_WARNING_MS = Number(import.meta.env.VITE_IDLE_WARNING_MS) || 60 * 1000

/**
 * App-wide inactivity guard. While the user is signed in it watches for activity
 * and, after `IDLE_TIMEOUT_MS` of none, signs them out. `IDLE_WARNING_MS` before
 * that it shows a countdown dialog so the user can stay signed in (and doesn't
 * lose in-progress work without warning). Signing out clears auth, which makes
 * `RequireAuth` redirect to /login — so this needs no router access and can live
 * directly under `AuthProvider`.
 *
 * Client-side only: the real session cap is the Cognito refresh-token validity.
 */
export function SessionTimeout() {
  const { isAuthed, signOut } = useAuth()

  const { warning, remainingMs, stayActive } = useIdleTimer({
    timeoutMs: IDLE_TIMEOUT_MS,
    warningMs: IDLE_WARNING_MS,
    enabled: isAuthed,
    onIdle: signOut,
  })

  if (!isAuthed) return null

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))

  return (
    <Dialog
      open={warning}
      // Closing the dialog (Esc / overlay / X) is a deliberate interaction, so
      // treat it as "I'm still here" rather than a sign-out.
      onOpenChange={(open) => {
        if (!open) stayActive()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Still there?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription>
            You&apos;ve been inactive for a while. For your security you&apos;ll be signed out in{" "}
            {seconds} second{seconds === 1 ? "" : "s"}.
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={signOut}>
            Sign out
          </Button>
          <Button onClick={stayActive}>Stay signed in</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
