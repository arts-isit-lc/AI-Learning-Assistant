import { useState } from "react"
import { useParams } from "react-router"
import { MdForum } from "react-icons/md"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useCourseMessages, useChatlogs, useChatlogStatus } from "@/services/queries"
import { http } from "@/services/http"
import { titleCase } from "@/utils/formatters"
import { useJobNotification } from "./hooks/useJobNotification"
import { EmptyState } from "@/components/composed/EmptyState"
import { SortableTable } from "@/components/composed/SortableTable"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { toUserMessage } from "@/services/apiError"
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogBody } from "@/components/ui/dialog"

// Message previews longer than this collapse to "...Show more", which opens the
// full text in a modal (Figma 376:2331).
const MESSAGE_PREVIEW_LIMIT = 250

// Figma 376:2331. 20 rows/page (the mockup's "Displaying 20 out of N results").
const PAGE_SIZE = 20

// Column ids MUST match the backend sort_by whitelist (course_messages_rows):
// user_email · module_name · concept_name · session_id · message_content.
// Name (the User column) ascending is the default sort. The three "Label"
// columns + row-select checkboxes in the mockup are omitted: there are no
// message labels/tags in the schema and no bulk action to back a selection.
const columns = [
  {
    accessorKey: "user_email",
    header: "User",
    size: 160,
    cell: ({ row }) => row.original.user_email || "—",
  },
  {
    accessorKey: "module_name",
    header: "Module name",
    size: 150,
    cell: ({ row }) => (row.original.module_name ? titleCase(row.original.module_name) : "—"),
  },
  {
    accessorKey: "concept_name",
    header: "Concept",
    size: 130,
    cell: ({ row }) => (row.original.concept_name ? titleCase(row.original.concept_name) : "—"),
  },
  {
    accessorKey: "session_id",
    header: "Session ID",
    size: 150,
    cell: ({ row }) => row.original.session_name || row.original.session_id || "—",
  },
  {
    accessorKey: "message_content",
    header: "Message",
    size: 240,
    cell: ({ row }) => <MessageCell message={row.original} />,
  },
]

/**
 * Message cell — shows the sender prefix + up to MESSAGE_PREVIEW_LIMIT chars of
 * the message. When the content is longer, the preview is followed by a
 * "...Show more" link that opens the full message in a modal (visually
 * title-less, the Dialog's built-in top-right close X, no footer/actions).
 * @param {{ message: { student_sent?: boolean, message_content?: string } }} props
 */
function MessageCell({ message }) {
  const prefix = message.student_sent ? "Student: " : "OCELIA: "
  const content = message.message_content || ""
  const isLong = content.length > MESSAGE_PREVIEW_LIMIT

  return (
    <div className="whitespace-normal break-words">
      <span className="font-semibold">{prefix}</span>
      {isLong ? content.slice(0, MESSAGE_PREVIEW_LIMIT).trimEnd() : content}
      {isLong && (
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="ml-0.5 font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              ...Show more
            </button>
          </DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            {/* Title kept for accessibility (Radix requires one) but visually
                hidden — the modal shows only the message body + close X. */}
            <DialogTitle className="sr-only">Message</DialogTitle>
            <DialogBody>
              <p className="whitespace-pre-wrap break-words text-body text-foreground">
                <span className="font-semibold text-muted-foreground">{prefix}</span>
                {content}
              </p>
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/**
 * Chat History tab — Figma 376:2331. An in-app, course-wide message table
 * (purple header) paginated over the B5 `course_messages_rows` endpoint. Columns
 * are sortable server-side (asc/desc; User is the default) and resizable via
 * drag handles (shared OCELIA look via `SortableTable`). The "Export CSV" toolbar
 * (top-right) runs the robust async full-course export — the browser only ever
 * holds one page; the complete log is generated server-side to S3.
 */
export function ChatHistoryTab() {
  const { courseId } = useParams()
  const [page, setPage] = useState(0)
  // Default: name (User column) ascending. Server sorts the full result set.
  const [sorting, setSorting] = useState([{ id: "user_email", desc: false }])
  const offset = page * PAGE_SIZE
  const sortBy = sorting[0]?.id ?? "user_email"
  const sortDir = sorting[0]?.desc ? "desc" : "asc"

  const { data, isLoading, isError, error, refetch } = useCourseMessages(courseId, {
    limit: PAGE_SIZE,
    offset,
    sortBy,
    sortDir,
  })
  const messages = data?.messages ?? []
  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const table = useReactTable({
    data: messages,
    columns,
    state: { sorting },
    // Sorting + pagination are server-side, so reset to the first page whenever
    // the sort changes (the current offset is meaningless against a new order).
    onSortingChange: (updater) => {
      setSorting((old) => (typeof updater === "function" ? updater(old) : updater))
      setPage(0)
    },
    manualSorting: true,
    enableSortingRemoval: false, // toggle asc <-> desc only; always keep a sort
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
  })

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
        },
      })
      await http.post(
        "instructor/course_messages",
        {},
        { course_id: courseId, instructor_email: email, request_id: requestId }
      )
    } catch {
      setExporting(false)
    }
  }

  const exportDisabled = exporting || status?.isEnabled === false || total === 0

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load chat history"
        description={toUserMessage(error)}
        onRetry={() => refetch()}
      />
    )
  }

  if (isLoading) {
    return (
      <div role="status" aria-label="Loading chat history" className="flex flex-col gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (total === 0) {
    return (
      <EmptyState
        icon={MdForum}
        title="No chat history yet"
        description="Messages appear here once students start chatting with this course's modules."
        className="border-0 bg-muted"
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        {/* Matches the admin "Add course" action (outline, sm, h-7 rounded-sm
            px-6) — Export CSV just omits the trailing icon. */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 rounded-sm px-6"
          onClick={handleExport}
          loading={exporting}
          disabled={exportDisabled}
        >
          Export CSV
        </Button>
      </div>

      <SortableTable table={table} page={page} pageCount={pageCount} onPageChange={setPage} total={total} />
    </div>
  )
}
