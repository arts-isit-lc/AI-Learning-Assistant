import { useCallback, useMemo, useState } from "react"
import { useParams, useSearchParams } from "react-router"
import { toUserMessage } from "@/services/apiError"
import { MdClose, MdPeople } from "react-icons/md"
import { getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table"
import { useStudents, useDeleteStudent } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { Searchbar } from "@/components/composed/Searchbar"
import { EmptyState } from "@/components/composed/EmptyState"
import { SortableTable } from "@/components/composed/SortableTable"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { StudentDetail } from "./StudentDetail"

// Roster rows per page — matches the Chat History table for a consistent feel.
const PAGE_SIZE = 20

/** "Lastname, Firstname" per the Figma roster; falls back to the email. */
function rosterName(s) {
  const last = titleCase(s.last_name || "")
  const first = titleCase(s.first_name || "")
  if (last && first) return `${last}, ${first}`
  return last || first || s.user_email
}

/**
 * Students tab — Figma 376:2525. A purple-header roster (Student · Contact ·
 * Remove) with a search field above, rendered through the shared `SortableTable`
 * so it matches the Chat History table: sortable Student/Contact columns (Remove
 * is not sortable), drag-resizable columns, zebra striping, and a numbered
 * pagination footer. Sorting + pagination are client-side (the whole roster is
 * loaded). Clicking a student's name opens their read-only chat history inline
 * via the `?student=` query param (deep-linkable, avoids an email in the path).
 *
 * Removals follow the Configuration tab's staged model: the × STAGES an
 * unenrolment (the row drops out immediately, but nothing is persisted), and the
 * footer Undo / Save changes revert or publish the staged removals together.
 * Save is the final gate — there's no per-row confirm dialog.
 */
export function StudentsTab() {
  const { courseId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedEmail = searchParams.get("student")

  const { data: students = [], isLoading, isError, error, refetch } = useStudents(courseId)
  const deleteStudent = useDeleteStudent(courseId)

  const [query, setQuery] = useState("")
  // Default sort: Student (name) ascending — mirrors Chat History defaulting to
  // its first column ascending.
  const [sorting, setSorting] = useState([{ id: "student", desc: false }])
  // Staged unenrolments (by email) — held locally, NOT persisted until "Save
  // changes" (revert with Undo). Mirrors the Configuration tab's staging model.
  const [deletedEmails, setDeletedEmails] = useState(() => new Set())
  const [saving, setSaving] = useState(false)

  const setStudentParam = useCallback(
    (email) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (email) next.set("student", email)
        else next.delete("student")
        return next
      }),
    [setSearchParams]
  )

  const stageRemoval = useCallback(
    (email) => setDeletedEmails((prev) => new Set(prev).add(email)),
    []
  )

  // Staged removals that still exist server-side (drives dirty state + the save
  // loop); the displayed roster drops them out.
  const stagedRemovals = useMemo(
    () => students.filter((s) => deletedEmails.has(s.user_email)),
    [students, deletedEmails]
  )
  const isDirty = stagedRemovals.length > 0

  const filtered = useMemo(() => {
    const roster = students.filter((s) => !deletedEmails.has(s.user_email))
    const q = query.trim().toLowerCase()
    if (!q) return roster
    return roster.filter((s) => `${rosterName(s)} ${s.user_email}`.toLowerCase().includes(q))
  }, [students, deletedEmails, query])

  const columns = useMemo(
    () => [
      {
        id: "student",
        accessorFn: (s) => rosterName(s),
        header: "Student",
        size: 200,
        cell: ({ row }) => (
          <button
            type="button"
            onClick={() => setStudentParam(row.original.user_email)}
            className="text-left text-neutral-900 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {rosterName(row.original)}
          </button>
        ),
      },
      {
        accessorKey: "user_email",
        header: "Contact",
        size: 200,
        cell: ({ row }) => row.original.user_email,
      },
      {
        id: "remove",
        header: "Remove",
        size: 90,
        enableSorting: false,
        enableResizing: false,
        // Header left-aligned like the others; the X button stays right-aligned.
        meta: { align: "right", headerAlign: "left" },
        cell: ({ row }) => (
          <button
            type="button"
            aria-label={`Remove ${rosterName(row.original)}`}
            onClick={() => stageRemoval(row.original.user_email)}
            className="rounded p-1 text-primary transition-colors hover:text-primary-dark active:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={MdClose} size={24} />
          </button>
        ),
      },
    ],
    [setStudentParam, stageRemoval]
  )

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    enableSortingRemoval: false, // toggle asc <-> desc only; always keep a sort
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    initialState: { pagination: { pageSize: PAGE_SIZE } },
    // autoResetPageIndex (default) snaps back to page 1 when the search filter
    // or roster changes, so we never sit on a now-empty page.
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  // Undo — drop every staged removal back to the last-saved (server) roster.
  const discardChanges = () => setDeletedEmails(new Set())

  // Save changes — publish the staged unenrolments. On failure each mutation
  // rolls back its own cache and surfaces the inline error below; staged
  // removals are kept so the user can retry.
  const saveChanges = async () => {
    setSaving(true)
    try {
      for (const s of stagedRemovals) {
        await deleteStudent.mutateAsync(s.user_email)
      }
      setDeletedEmails(new Set())
    } catch {
      // Surfaced via deleteStudent.isError (inline Alert below); staged edits kept.
    } finally {
      setSaving(false)
    }
  }

  // Inline per-student chat history (a sub-state of the Students tab).
  if (selectedEmail) {
    const match = students.find((s) => s.user_email === selectedEmail)
    return (
      <StudentDetail
        courseId={courseId}
        email={selectedEmail}
        name={match ? rosterName(match) : undefined}
        onBack={() => setStudentParam(null)}
      />
    )
  }

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load the roster"
        description={toUserMessage(error)}
        onRetry={() => refetch()}
      />
    )
  }

  if (!isLoading && students.length === 0) {
    return (
      <EmptyState
        icon={MdPeople}
        title="No students enrolled yet"
        description="Students appear here once they join with the course access code."
        className="border-0 bg-muted"
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Guard staged removals against navigation (tab switch / back / refresh). */}
      <UnsavedChangesPrompt when={isDirty} />

      <Searchbar value={query} onChange={setQuery} placeholder="Search students" />

      {deleteStudent.isError && (
        <Alert variant="destructive">
          <AlertDescription>{"Couldn't remove the student. Please try again."}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div role="status" aria-label="Loading roster" className="flex flex-col gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <SortableTable
          table={table}
          page={table.getState().pagination.pageIndex}
          pageCount={table.getPageCount()}
          onPageChange={(p) => table.setPageIndex(p)}
          total={filtered.length}
          emptyMessage="No students match your search."
        />
      )}

      {/* Footer — Undo + Save changes gate the STAGED unenrolments (revert or
          publish them together). Styling matched exactly to the Configuration
          tab: 28px tall (h-7 + size-sm), 4px radius (rounded), lavender
          (#F2E8FF / primary-subtle) hover, #BFBFBF (neutral-400) inactive text
          on a white fill (disabled:opacity-100 defeats the base fade). Once
          active (dirty) the text turns #6829C2 (primary) with the ghost-primary
          interaction; Save also gains a #6829C2 border (transparent while
          disabled → no layout shift), Undo stays borderless. */}
      {!isLoading && (
        <div className="flex items-center justify-end gap-4 border-t border-border pt-6">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark disabled:opacity-100",
              isDirty ? "text-primary" : "bg-background text-neutral-400"
            )}
            onClick={discardChanges}
            disabled={!isDirty || saving}
          >
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded border hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark disabled:opacity-100",
              isDirty ? "border-primary text-primary" : "border-transparent bg-background text-neutral-400"
            )}
            onClick={saveChanges}
            disabled={!isDirty || saving}
            loading={saving}
          >
            Save changes
          </Button>
        </div>
      )}
    </div>
  )
}
