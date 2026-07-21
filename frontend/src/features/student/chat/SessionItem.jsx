import { MdChat, MdDelete } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * A single "Previous chats" row (Figma frames): a bordered box with a filled
 * chat glyph + the session name + a trash button. Active = filled purple.
 *
 * @param {{ session: { session_id: string, session_name?: string }, isActive?: boolean, onSelect?: (s: object) => void, onDelete?: (s: object) => void }} props
 */
export function SessionItem({ session, isActive = false, onSelect, onDelete }) {
  const name = session.session_name || "New chat"
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-sm border px-3 py-2 transition-colors",
        isActive
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-primary hover:bg-primary-subtle"
      )}
    >
      <button
        type="button"
        onClick={() => onSelect?.(session)}
        aria-current={isActive ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={MdChat} size={16} className="shrink-0" />
        <span className="truncate text-caption">{name}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(session)}
          aria-label={`Delete chat: ${name}`}
          className="shrink-0 rounded-sm p-1 opacity-80 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={MdDelete} size={16} />
        </button>
      )}
    </div>
  )
}
