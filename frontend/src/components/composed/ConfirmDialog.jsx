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
import { Alert, AlertDescription } from "@/components/ui/alert"

/**
 * Confirmation modal for destructive/important actions (delete course, discard,
 * prompt-conflict override, ...). Controlled via `open` / `onOpenChange`. The
 * confirm button shows a loading spinner while the action runs.
 *
 * Pass `error` (a user-facing string) when the confirmed action fails: it shows
 * inline and the dialog stays open so the user can retry or cancel.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  loading = false,
  error,
}) {
  const handleCancel = () => {
    onCancel?.()
    onOpenChange?.(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* Only mount the body when there's content, so a description-less
            confirm keeps its single 32px header→footer gap (no empty body). */}
        {(description || error) && (
          <DialogBody>
            {description && <DialogDescription>{description}</DialogDescription>}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          {/* Confirm is always the primary action button — #6829C2 with white
              text, hovering to #2E0666 (primary-dark) — including destructive
              confirms: the title + label (e.g. "Delete course?" / "Delete")
              carry the destructive meaning, not the colour. */}
          <Button className="hover:bg-primary-dark" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
