import { MdPerson, MdDelete } from "react-icons/md"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Icon } from "@/components/ui/icon"

/**
 * Student (user) message — right-aligned bubble. The delete control appears on
 * hover/focus, but only on the most-recent student message that has an AI reply
 * after it (so a student can undo the last exchange). Kept keyboard-reachable
 * (focus-visible reveals it), not hover-only.
 *
 * @param {{ content: string, isMostRecent?: boolean, hasAiMessageAfter?: boolean, onDelete?: () => void }} props
 */
export function StudentMessage({ content, isMostRecent = false, hasAiMessageAfter = false, onDelete }) {
  const canDelete = isMostRecent && hasAiMessageAfter && typeof onDelete === "function"

  return (
    <div className="group mb-6 flex flex-row-reverse items-start gap-3">
      <Avatar className="h-8 w-8 shrink-0">
        <AvatarFallback className="bg-primary text-primary-foreground">
          <Icon icon={MdPerson} size={18} />
        </AvatarFallback>
      </Avatar>
      <div className="max-w-xl whitespace-pre-wrap break-words rounded-xl bg-secondary p-4 text-caption text-secondary-foreground">
        {content}
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete this message and all that follow"
          className="mt-1 shrink-0 rounded-full p-2 text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        >
          <Icon icon={MdDelete} size={16} />
        </button>
      )}
    </div>
  )
}
