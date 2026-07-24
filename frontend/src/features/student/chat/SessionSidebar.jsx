import { MdChevronLeft, MdAddComment, MdExpandLess, MdExpandMore, MdDescription } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { SessionItem } from "./SessionItem"

/**
 * Left panel of the module chat (Figma frames): a module-title row with a
 * back-to-course control + a new-chat button, the "Previous chats" list
 * (most-recent first), and a collapsible "Module materials" section pinned to
 * the bottom whose files open the reference-doc column.
 */
export function SessionSidebar({
  moduleName,
  onBack,
  onNew,
  creating = false,
  loading = false,
  sessions = [],
  activeSessionId,
  onSelect,
  onDelete,
  files = [],
  filesLoading = false,
  materialsOpen = false,
  onToggleMaterials,
  activeDocId,
  onOpenDoc,
}) {
  const ordered = sessions.slice().reverse()

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-start gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to course"
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary text-primary transition-colors hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={MdChevronLeft} size={16} />
            </button>
          )}
          <h2 className="text-h4 text-neutral-900">{moduleName}</h2>
        </div>
        <button
          type="button"
          onClick={onNew}
          disabled={creating}
          aria-label="New chat"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-primary text-primary transition-colors hover:bg-primary-subtle disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={MdAddComment} size={18} />
        </button>
      </div>

      <div className="border-t border-border" />

      <p className="text-lg leading-7 font-semibold text-neutral-900 py-4">Previous chats</p>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 pr-2">
          {loading ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)
          ) : (
            <>
              {creating && <Skeleton className="h-10 w-full" />}
              {ordered.map((session) => (
                <SessionItem
                  key={session.session_id}
                  session={session}
                  isActive={session.session_id === activeSessionId}
                  onSelect={onSelect}
                  onDelete={onDelete}
                />
              ))}
            </>
          )}
        </div>
      </ScrollArea>

      <div className="mt-auto">
        <div className="border-t border-border" />
        <button
          type="button"
          onClick={onToggleMaterials}
          aria-expanded={materialsOpen}
          className="flex w-full items-center justify-between py-2 text-caption font-semibold text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Module materials
          <Icon icon={materialsOpen ? MdExpandMore : MdExpandLess} size={18} />
        </button>
        {materialsOpen && (
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto pb-1">
            {filesLoading ? (
              [0, 1].map((i) => <Skeleton key={i} className="h-8 w-full" />)
            ) : files.length ? (
              files.map((file) => (
                <button
                  key={file.file_id}
                  type="button"
                  onClick={() => onOpenDoc?.(file.file_id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    activeDocId === file.file_id
                      ? "bg-primary text-primary-foreground"
                      : "text-foreground hover:bg-primary-subtle"
                  )}
                >
                  <Icon icon={MdDescription} size={16} className="shrink-0" />
                  <span className="truncate">{file.file_name || file.file_id}</span>
                </button>
              ))
            ) : (
              <p className="px-2 py-1 text-caption text-muted-foreground">No materials.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
