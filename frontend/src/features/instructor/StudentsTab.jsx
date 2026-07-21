import { useMemo, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdClose, MdPeople } from "react-icons/md"
import { useStudents, useDeleteStudent } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { Searchbar } from "@/components/composed/Searchbar"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { EmptyState } from "@/components/composed/EmptyState"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { StudentDetail } from "./StudentDetail"

/** "Lastname, Firstname" per the Figma roster; falls back to the email. */
function rosterName(s) {
  const last = titleCase(s.last_name || "")
  const first = titleCase(s.first_name || "")
  if (last && first) return `${last}, ${first}`
  return last || first || s.user_email
}

/**
 * Students tab — Figma 376:2525. A purple-header roster (Student · Contact ·
 * Remove) with a search field above; clicking a student's name opens their
 * read-only chat history inline via the `?student=` query param (deep-linkable,
 * avoids an email in the path). The × removes (unenrolls) a student after a
 * confirm — removal persists immediately, so there's no Undo/Save footer (same
 * save-only decision as Configuration). The course access code lives in the
 * course-detail header, so it's not repeated here.
 */
export function StudentsTab() {
  const { courseId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedEmail = searchParams.get("student")

  const { data: students = [], isLoading, isError } = useStudents(courseId)
  const deleteStudent = useDeleteStudent(courseId)

  const [query, setQuery] = useState("")
  const [removeTarget, setRemoveTarget] = useState(null)

  const setStudentParam = (email) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (email) next.set("student", email)
      else next.delete("student")
      return next
    })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return students
    return students.filter((s) => `${rosterName(s)} ${s.user_email}`.toLowerCase().includes(q))
  }, [students, query])

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
      <Alert variant="destructive">
        <AlertTitle>Couldn&rsquo;t load the roster</AlertTitle>
        <AlertDescription>Please refresh and try again.</AlertDescription>
      </Alert>
    )
  }

  if (!isLoading && students.length === 0) {
    return (
      <EmptyState
        icon={MdPeople}
        title="No students enrolled yet"
        description="Students appear here once they join with the course access code."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Searchbar value={query} onChange={setQuery} placeholder="Search students" />

      <div className="overflow-hidden rounded-sm border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="bg-primary font-semibold text-primary-foreground">Student</TableHead>
              <TableHead className="bg-primary font-semibold text-primary-foreground">Contact</TableHead>
              <TableHead className="bg-primary text-right font-semibold text-primary-foreground">
                Remove
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  {[0, 1, 2].map((j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  No students match your search.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((s) => (
                <TableRow key={s.user_email}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setStudentParam(s.user_email)}
                      className="text-left text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {rosterName(s)}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.user_email}</TableCell>
                  <TableCell className="text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${rosterName(s)}`}
                      onClick={() => setRemoveTarget(s)}
                      className="rounded p-1 text-primary hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Icon icon={MdClose} size={18} />
                    </button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title="Delete student?"
        description={
          removeTarget
            ? `You are about to remove ${rosterName(removeTarget)} from this course. If they need access again, you'll need to send a new invitation to join.`
            : ""
        }
        confirmLabel="Delete student"
        variant="danger"
        loading={deleteStudent.isPending}
        onConfirm={() =>
          deleteStudent.mutate(removeTarget.user_email, {
            onSuccess: () => {
              setRemoveTarget(null)
              toast.success("Student removed")
            },
          })
        }
      />
    </div>
  )
}
