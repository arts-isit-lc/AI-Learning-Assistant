import { useMemo, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
import { toast } from "react-toastify"
import { useStudents, useAccessCode, useRegenerateAccessCode, useDeleteStudent } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { DataTable } from "@/components/composed/DataTable"
import { Searchbar } from "@/components/composed/Searchbar"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { StudentDetail } from "./StudentDetail"

function studentName(s) {
  const full = `${titleCase(s.first_name || "")} ${titleCase(s.last_name || "")}`.trim()
  return full || s.user_email
}

/**
 * Students tab — roster + course access code + unenroll, with a read-only
 * per-student chat-history detail opened inline via the `?student=` query param
 * (deep-linkable + refresh-safe, and avoids putting an email in the path).
 */
export function StudentsTab() {
  const { courseId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedEmail = searchParams.get("student")

  const { data: students = [], isLoading, isError } = useStudents(courseId)
  const { data: accessCode } = useAccessCode(courseId)
  const regenerate = useRegenerateAccessCode(courseId)
  const deleteStudent = useDeleteStudent(courseId)

  const [query, setQuery] = useState("")
  const [unenrollTarget, setUnenrollTarget] = useState(null)
  const [regenOpen, setRegenOpen] = useState(false)

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
    return students.filter((s) => `${studentName(s)} ${s.user_email}`.toLowerCase().includes(q))
  }, [students, query])

  // Inline detail view (a sub-state of the Students tab).
  if (selectedEmail) {
    const match = students.find((s) => s.user_email === selectedEmail)
    return (
      <StudentDetail
        courseId={courseId}
        email={selectedEmail}
        name={match ? studentName(match) : undefined}
        onBack={() => setStudentParam(null)}
      />
    )
  }

  const columns = [
    { id: "name", header: "Name", cell: ({ row }) => studentName(row.original) },
    { accessorKey: "user_email", header: "Email" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStudentParam(row.original.user_email)}>
            View chats
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setUnenrollTarget(row.original)}>
            Unenroll
          </Button>
        </div>
      ),
    },
  ]

  const copyCode = async () => {
    if (!accessCode) return
    try {
      await navigator.clipboard.writeText(accessCode)
      toast.success("Access code copied")
    } catch {
      toast.error("Couldn't copy the code")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex flex-col gap-1">
            <p className="text-caption text-muted-foreground">Course access code</p>
            <p className="font-mono text-h4 text-navy">{accessCode || "—"}</p>
            <p className="text-caption text-muted-foreground">
              Students use this code to join the course.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyCode} disabled={!accessCode}>
              Copy
            </Button>
            <Button variant="outline" onClick={() => setRegenOpen(true)}>
              Regenerate
            </Button>
          </div>
        </CardContent>
      </Card>

      {isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&rsquo;t load the roster</AlertTitle>
          <AlertDescription>Please refresh and try again.</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          {students.length > 0 && (
            <Searchbar
              value={query}
              onChange={setQuery}
              placeholder="Search students"
              className="max-w-sm"
            />
          )}
          <DataTable
            columns={columns}
            data={filtered}
            loading={isLoading}
            emptyMessage="No students enrolled yet."
          />
        </div>
      )}

      <ConfirmDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        title="Regenerate access code?"
        description="The current code will stop working. Students will need the new code to join."
        confirmLabel="Regenerate"
        variant="danger"
        loading={regenerate.isPending}
        onConfirm={() =>
          regenerate.mutate(undefined, {
            onSuccess: () => {
              setRegenOpen(false)
              toast.success("Access code regenerated")
            },
          })
        }
      />

      <ConfirmDialog
        open={Boolean(unenrollTarget)}
        onOpenChange={(open) => !open && setUnenrollTarget(null)}
        title="Unenroll student?"
        description={
          unenrollTarget ? `Remove ${studentName(unenrollTarget)} from this course?` : ""
        }
        confirmLabel="Unenroll"
        variant="danger"
        loading={deleteStudent.isPending}
        onConfirm={() =>
          deleteStudent.mutate(unenrollTarget.user_email, {
            onSuccess: () => {
              setUnenrollTarget(null)
              toast.success("Student unenrolled")
            },
          })
        }
      />
    </div>
  )
}
