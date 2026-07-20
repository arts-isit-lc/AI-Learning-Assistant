import { MdAdd } from "react-icons/md"
import { BackButton } from "@/components/composed/BackButton"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { SessionItem } from "./SessionItem"

/**
 * Left panel of the chat: module title + back, "New chat", and the session
 * history (most-recent first).
 */
export function SessionSidebar({
  moduleName,
  sessions = [],
  activeSessionId,
  onSelect,
  onNew,
  onDelete,
  onBack,
  creating = false,
  loading = false,
}) {
  const ordered = sessions.slice().reverse()
  return (
    <div className="flex h-full w-64 shrink-0 flex-col gap-3 bg-secondary p-3">
      <div className="flex flex-col gap-2">
        {onBack && <BackButton onClick={onBack} className="self-start" />}
        <h2 className="truncate px-1 text-h4 font-semibold text-navy">{moduleName}</h2>
      </div>
      <Button variant="outline" onClick={onNew} disabled={creating} className="w-full gap-2">
        <Icon icon={MdAdd} size={18} />
        New chat
      </Button>
      <Separator />
      <p className="px-1 text-caption font-semibold text-muted-foreground">History</p>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 pr-2">
          {loading ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)
          ) : (
            <>
              {creating && <Skeleton className="h-9 w-full" />}
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
    </div>
  )
}
