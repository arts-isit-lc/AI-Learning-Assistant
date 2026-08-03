import {
  Dialog,
  DialogContent,
  DialogHeader,
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
  variant = "danger",
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
        {description && <DialogDescription>{description}</DialogDescription>}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
            // Primary (#6829C2) confirms hover to #2E0666 (primary-dark); danger
            // and other variants keep their own hover.
            className={variant === "default" ? "hover:bg-primary-dark" : undefined}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
