import { Button } from "@/components/ui/button"

/** Inline error banner when an AI response fails; single user-triggered retry. */
export function RetryBanner({ onRetry, message = "Something went wrong generating a response." }) {
  return (
    <div role="alert" className="mb-6 flex items-center gap-3">
      <span className="text-caption text-destructive">{message}</span>
      <Button variant="danger" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
