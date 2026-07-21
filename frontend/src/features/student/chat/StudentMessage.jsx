import { MdDelete } from "react-icons/md"
import { Icon } from "@/components/ui/icon"

/**
 * Student (user) message — Figma frames: right-aligned text with a small purple
 * sphere marker, NO bubble. The delete control appears on hover/focus, but only
 * on the most-recent student message that has an AI reply after it (so a student
 * can undo the last exchange). Kept keyboard-reachable, not hover-only.
 *
 * @param {{ content: string, isMostRecent?: boolean, hasAiMessageAfter?: boolean, onDelete?: () => void }} props
 */
export function StudentMessage({ content, isMostRecent = false, hasAiMessageAfter = false, onDelete }) {
  const canDelete = isMostRecent && hasAiMessageAfter && typeof onDelete === "function"

  return (
    <div className="group mb-6 flex items-start justify-end gap-3">
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete this message and all that follow"
          className="mt-0.5 shrink-0 rounded-full p-2 text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Icon icon={MdDelete} size={16} />
        </button>
      )}
      <span
        aria-hidden="true"
        className="mt-1 h-6 w-6 shrink-0 rounded-full bg-gradient-to-b from-primary to-navy"
      />
      <div className="max-w-xl whitespace-pre-wrap break-words text-right text-caption text-foreground">
        {content}
      </div>
    </div>
  )
}
