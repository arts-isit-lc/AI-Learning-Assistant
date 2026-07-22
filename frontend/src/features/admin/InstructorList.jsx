import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useAdminInstructors } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { Searchbar } from "@/components/composed/Searchbar"
import { ListRow } from "@/components/composed/ListRow"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"

/** Display name for an instructor ("Lastname, Firstname" per Figma), else the email. */
export function instructorLabel(instructor) {
  if (instructor.first_name && instructor.last_name) {
    return `${titleCase(instructor.last_name)}, ${titleCase(instructor.first_name)}`
  }
  return instructor.user_email
}

/** Two-letter avatar initials (name if present, else the email). */
function initialsOf(instructor) {
  if (instructor.first_name && instructor.last_name) {
    return `${instructor.first_name[0]}${instructor.last_name[0]}`.toUpperCase()
  }
  return (instructor.user_email?.[0] ?? "?").toUpperCase()
}

/**
 * Instructor management master pane (rendered as the SplitLayout `list`). Search
 * + navigate to a detail. Each row is an avatar + name (left) + email (right),
 * flush and divider-separated, with the selected row filled (see `ListRow`). The
 * "Add instructor" action lives in the admin section header (`AdminLayout`), not
 * here.
 */
export function InstructorList() {
  const navigate = useNavigate()
  const { instructorId } = useParams()
  const selectedEmail = instructorId ? decodeURIComponent(instructorId) : null

  const { data: instructors = [], isLoading } = useAdminInstructors()
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return instructors
    return instructors.filter((i) => `${instructorLabel(i)} ${i.user_email}`.toLowerCase().includes(q))
  }, [instructors, query])

  return (
    <div className="flex flex-col gap-6">
      <Searchbar
        value={query}
        onChange={setQuery}
        placeholder="Search instructors"
        inputClassName="h-[50px]"
      />

      <div className="flex max-h-[calc(100vh-18rem)] flex-col overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-3 text-caption text-muted-foreground">No instructors found.</p>
        ) : (
          filtered.map((instructor) => {
            const named = Boolean(instructor.first_name && instructor.last_name)
            return (
              <ListRow
                key={instructor.user_email}
                selected={selectedEmail === instructor.user_email}
                onClick={() =>
                  navigate(`/admin/instructors/${encodeURIComponent(instructor.user_email)}`)
                }
              >
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="bg-primary text-caption text-primary-foreground group-aria-[current=true]:bg-primary-foreground group-aria-[current=true]:text-primary">
                    {initialsOf(instructor)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-caption font-medium text-foreground group-aria-[current=true]:text-primary-foreground">
                  {instructorLabel(instructor)}
                </span>
                <span
                  className={cn(
                    "shrink-0 truncate text-caption group-aria-[current=true]:text-primary-foreground/90",
                    named
                      ? "text-primary underline underline-offset-2"
                      : "italic text-muted-foreground"
                  )}
                >
                  {named ? instructor.user_email : "Invited — awaiting signup"}
                </span>
              </ListRow>
            )
          })
        )}
      </div>
    </div>
  )
}
