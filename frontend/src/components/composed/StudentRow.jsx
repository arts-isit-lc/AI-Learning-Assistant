import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

function initialsOf(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

/**
 * Roster row — avatar, name, email, and an actions slot.
 * @param {{ student: { name?: string, first_name?: string, last_name?: string, email?: string }, actions?: React.ReactNode, className?: string }} props
 */
export function StudentRow({ student, actions, className }) {
  const name =
    student?.name ||
    [student?.first_name, student?.last_name].filter(Boolean).join(" ") ||
    student?.email ||
    "Student"

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar className="h-9 w-9">
          <AvatarFallback>{initialsOf(name)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-caption font-semibold text-foreground">{name}</span>
          {student?.email && (
            <span className="truncate text-caption text-muted-foreground">{student.email}</span>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
