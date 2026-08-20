import { useCallback, useMemo, useState } from "react"
import { useParams, useSearchParams } from "react-router"
import { toUserMessage } from "@/services/apiError"
import { MdClose, MdPeople } from "react-icons/md"
import { getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table"
import { useStudents, useDeleteStudent } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { Searchbar } from "@/components/composed/Searchbar"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { EmptyState } from "@/components/composed/EmptyState"
import { SortableTable } from "@/components/composed/SortableTable"
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
 * The × removes (unenrolls) a student after a confirm — removal persists
 * immediately, so there's no Undo/Save footer (same save-only decision as
 * Configuration). The course access code lives in the course-detail header.
 */
export function StudentsTab() {
  const { courseId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedEmail = searchParams.get("student")

  const { data: students = [], isLoading, isError, error, refetch } = useStudents(courseId)
  const deleteStudent = useDeleteStudent(courseId)

  const [query, setQuery] = useState("")
  const [removeTarget, setRemoveTarget] = useState(null)
  // Default sort: Student (name) ascending — mirrors Chat History defaulting to
  // its first column ascending.
  const [sorting, setSorting] = useState([{ id: "student", desc: false }])

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return students
    return students.filter((s) => `${rosterName(s)} ${s.user_email}`.toLowerCase().includes(q))
  }, [students, query])

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
        meta: { align: "right" },
        cell: ({ row }) => (
          <button
            type="button"
            aria-label={`Remove ${rosterName(row.original)}`}
            onClick={() => setRemoveTarget(row.original)}
            className="rounded p-1 text-primary transition-colors hover:text-primary-dark active:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={MdClose} size={24} />
          </button>
        ),
      },
    ],
    [setStudentParam]
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
    // changes, so we never sit on a now-empty page.
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

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
      <Searchbar value={query} onChange={setQuery} placeholder="Search students" />

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

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null)
            deleteStudent.reset?.()
          }
        }}
        title="Delete student?"
        description={
          removeTarget
            ? `You are about to remove ${rosterName(removeTarget)} from this course. If they need access again, you'll need to send a new invitation to join.`
            : ""
        }
        confirmLabel="Delete student"
        loading={deleteStudent.isPending}
        error={deleteStudent.isError ? toUserMessage(deleteStudent.error) : undefined}
        onConfirm={() =>
          deleteStudent.mutate(removeTarget.user_email, {
            onSuccess: () => setRemoveTarget(null),
          })
        }
      />
    </div>
  )
}
