import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

/**
 * Confirmation modal for destructive/important actions (delete course, discard,
 * prompt-conflict override, ...). Controlled via `open` / `onOpenChange`. The
 * confirm button shows a loading spinner while the action runs.
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
}) {
  const handleCancel = () => {
    onCancel?.()
    onOpenChange?.(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Figma modal chrome: title over a divider, body, then a footer divider. */}
        <DialogHeader className="border-b border-border pb-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description && <DialogDescription>{description}</DialogDescription>}
        <DialogFooter className="border-t border-border pt-4">
          <Button variant="outline" onClick={handleCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
