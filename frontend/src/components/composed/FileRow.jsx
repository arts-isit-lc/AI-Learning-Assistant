import { MdInsertDriveFile, MdDelete } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"

/**
 * File entry in file-management lists. `onClick` opens/previews; optional
 * `onDelete` renders a delete control.
 * @param {{ file: { file_id?: string, file_name?: string, name?: string }, onClick?: () => void, onDelete?: () => void, className?: string }} props
 */
export function FileRow({ file, onClick, onDelete, className }) {
  const name = file?.file_name ?? file?.name ?? "Untitled file"
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2",
        className
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={MdInsertDriveFile} size={18} className="shrink-0 text-muted-foreground" />
        <span className="truncate text-caption text-foreground">{name}</span>
      </button>
      {onDelete && (
        <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Delete ${name}`}>
          <Icon icon={MdDelete} size={18} />
        </Button>
      )}
    </div>
  )
}
