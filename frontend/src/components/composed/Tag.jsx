import { MdClose } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Key-topic / category tag (distinct from the status `Badge`). Optional
 * `onRemove` renders a dismiss button (editable-tag state).
 */
export function Tag({ label, onRemove, className }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-caption text-foreground",
        className
      )}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="rounded-sm opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={MdClose} size={14} />
        </button>
      )}
    </span>
  )
}
