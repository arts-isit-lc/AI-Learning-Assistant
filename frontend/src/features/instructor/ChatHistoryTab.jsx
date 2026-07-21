import { useState } from "react"
import { useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdForum } from "react-icons/md"
import { useCourseMessages, useChatlogs, useChatlogStatus } from "@/services/queries"
import { http } from "@/services/http"
import { titleCase } from "@/utils/formatters"
import { useJobNotification } from "./hooks/useJobNotification"
import { EmptyState } from "@/components/composed/EmptyState"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"

const PAGE_SIZE = 50
// Figma 376:2331. The three "Label" columns + row-select checkboxes in the mockup
// are omitted: there are no message labels/tags in the schema and no bulk action
// to back a selection. (Flagged — they slot in if message classification lands.)
const HEADERS = ["User", "Module name", "Concept", "Session ID", "Message"]

/**
 * Chat History tab — Figma 376:2331. An in-app, course-wide message table
 * (purple header) paginated over the B5 `course_messages_rows` endpoint, with an
 * "Export CSV" footer that runs the robust async full-course export (the browser
 * only ever holds one page; the complete log is generated server-side to S3).
 */
export function ChatHistoryTab() {
  const { courseId } = useParams()
  const [page, setPage] = useState(0)
  const offset = page * PAGE_SIZE

  const { data, isLoading, isError } = useCourseMessages(courseId, { limit: PAGE_SIZE, offset })
  const messages = data?.messages ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Export reuses the existing async CSV job: subscribe to the completion event
  // FIRST (so it can't be missed), submit the job, then download on notify.
  const { data: status } = useChatlogStatus(courseId)
  const { refetch: refetchLogs } = useChatlogs(courseId)
  const { subscribe } = useJobNotification()
  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    const requestId = crypto.randomUUID()
    try {
      const { email } = await http.getAuth()
      await subscribe(requestId, {
        onNotify: async () => {
          try {
            await http.del("instructor/remove_completed_notification", {
              course_id: courseId,
              instructor_email: email,
            })
          } catch {
            // best-effort cleanup
          }
          const { data: logs } = await refetchLogs()
          const newest = Array.isArray(logs) && logs.length ? logs[0] : null
          if (newest?.url) window.open(newest.url, "_blank")
          setExporting(false)
          toast.success("Chat logs exported")
        },
      })
      await http.post(
        "instructor/course_messages",
        {},
        { course_id: courseId, instructor_email: email, request_id: requestId }
      )
      toast.info("Generating chat logs — you'll be notified when they're ready.")
    } catch {
      setExporting(false)
      toast.error("Couldn't start the export")
    }
  }

  const exportDisabled = exporting || status?.isEnabled === false || total === 0

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&rsquo;t load chat history</AlertTitle>
        <AlertDescription>Please refresh and try again.</AlertDescription>
      </Alert>
    )
  }

  if (!isLoading && messages.length === 0) {
    return (
      <EmptyState
        icon={MdForum}
        title="No chat history yet"
        description="Messages appear here once students start chatting with this course's modules."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-sm border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {HEADERS.map((h) => (
                <TableHead key={h} className="bg-primary font-semibold text-primary-foreground">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {HEADERS.map((h) => (
                      <TableCell key={h}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : messages.map((m, i) => (
                  <TableRow key={`${m.session_id ?? "s"}-${i}`}>
                    <TableCell className="text-foreground">{m.user_email || "—"}</TableCell>
                    <TableCell>{m.module_name ? titleCase(m.module_name) : "—"}</TableCell>
                    <TableCell>{m.concept_name ? titleCase(m.concept_name) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.session_name || m.session_id || "—"}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <span className="block truncate">
                        <span className="font-semibold text-muted-foreground">
                          {m.student_sent ? "Student: " : "OCELIA: "}
                        </span>
                        {m.message_content || ""}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-caption text-muted-foreground">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <span>
            Page {page + 1} of {pageCount}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
        <Button variant="ghost" onClick={handleExport} loading={exporting} disabled={exportDisabled}>
          Export CSV
        </Button>
      </div>
    </div>
  )
}
