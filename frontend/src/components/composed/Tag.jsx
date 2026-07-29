import { MdClose } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Key-topic / category tag — Figma `Tag/Editable`: a fully-rounded pill with a
 * purple outline + purple text (distinct from the status `Badge`). Optional
 * `onRemove` renders the dismiss (×) button; optional `onClick` makes the label
 * a button (e.g. click-to-edit).
 */
export function Tag({ label, onRemove, onClick, className }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-primary bg-background px-3 py-0.5 text-caption text-primary",
        className
      )}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={`Edit ${label}`}
          className="rounded-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="rounded-full text-primary/70 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={MdClose} size={14} />
        </button>
      )}
    </span>
  )
}
