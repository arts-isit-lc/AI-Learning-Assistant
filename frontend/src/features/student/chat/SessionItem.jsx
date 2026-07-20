import { MdChatBubbleOutline, MdDelete } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * A single chat-session row in the sidebar. Active = filled; delete appears on
 * hover/focus (keyboard-reachable, not hover-only).
 *
 * @param {{ session: { session_id: string, session_name?: string }, isActive?: boolean, onSelect?: (s: object) => void, onDelete?: (s: object) => void }} props
 */
export function SessionItem({ session, isActive = false, onSelect, onDelete }) {
  const name = session.session_name || "New chat"
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-3 py-2 transition-colors",
        isActive ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"
      )}
    >
      <button
        type="button"
        onClick={() => onSelect?.(session)}
        aria-current={isActive ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={MdChatBubbleOutline} size={16} className="shrink-0 opacity-70" />
        <span className="truncate text-caption">{name}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(session)}
          aria-label={`Delete chat: ${name}`}
          className={cn(
            "shrink-0 rounded p-1 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100",
            isActive ? "hover:bg-primary-foreground/20" : "hover:bg-background"
          )}
        >
          <Icon icon={MdDelete} size={14} />
        </button>
      )}
    </div>
  )
}
