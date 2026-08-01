import { cn } from "@/lib/utils"
import { MdErrorOutline } from "react-icons/md"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"

/**
 * Inline error placeholder for a failed data load — the error-state sibling of
 * `EmptyState`. Shows a message and an optional Retry action (wire it to a
 * query's `refetch`). Presentational only: callers supply the copy (e.g. via
 * `toUserMessage(error)`), so it carries no data-layer knowledge.
 *
 * @param {{
 *   icon?: React.ComponentType,
 *   title?: string,
 *   description?: string,
 *   onRetry?: () => void,
 *   retryLabel?: string,
 *   className?: string,
 * }} props
 */
export function ErrorState({
  icon = MdErrorOutline,
  title = "Something went wrong",
  description = "We couldn't load this. Please try again.",
  onRetry,
  retryLabel = "Try again",
  className,
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-12 text-center",
        className
      )}
    >
      {icon && <Icon icon={icon} size={40} className="text-destructive" />}
      <h3 className="text-h4 font-semibold text-foreground">{title}</h3>
      {description && <p className="max-w-sm text-caption text-muted-foreground">{description}</p>}
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-2">
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
