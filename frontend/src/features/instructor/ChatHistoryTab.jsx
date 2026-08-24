import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router"
import { MdForum } from "react-icons/md"
import { getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useCourseMessages, useChatlogs } from "@/services/queries"
import { http } from "@/services/http"
import { titleCase } from "@/utils/formatters"
import { useJobNotification } from "./hooks/useJobNotification"
import { EmptyState } from "@/components/composed/EmptyState"
import { Searchbar } from "@/components/composed/Searchbar"
import { SortableTable } from "@/components/composed/SortableTable"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toUserMessage } from "@/services/apiError"
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogBody } from "@/components/ui/dialog"

// Message previews longer than this collapse to "...Show more", which opens the
// full text in a modal (Figma 376:2331).
const MESSAGE_PREVIEW_LIMIT = 250

// Figma 376:2331. 20 rows/page (the mockup's "Displaying 20 out of N results").
const PAGE_SIZE = 20

// Export is an async server job: the browser POSTs a job, then learns it's done
// via an AppSync WebSocket `onNotify`. That single realtime frame is treated as a
// best-effort FAST path only — the worker sets the DB completion flag and uploads
// the CSV *before* it notifies, so a polling backstop (a new log file appearing)
// reliably completes the export even if the WebSocket frame is missed/dropped.
// Without this the button spun forever whenever the notification didn't arrive.
const EXPORT_POLL_INTERVAL_MS = 4000
// Overall ceiling: past this we stop waiting and surface an actionable error
// instead of an endless spinner. Above the worker Lambda's 300s timeout is
// unnecessary — a healthy full-course export finishes in seconds.
const EXPORT_TIMEOUT_MS = 180000

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
  // Free-text search (debounced by Searchbar). Filters the whole result set
  // server-side — not just the current page.
  const [search, setSearch] = useState("")
  const hasSearch = search.trim().length > 0
  const offset = page * PAGE_SIZE
  const sortBy = sorting[0]?.id ?? "user_email"
  const sortDir = sorting[0]?.desc ? "desc" : "asc"

  const { data, isLoading, isError, error, refetch } = useCourseMessages(courseId, {
    limit: PAGE_SIZE,
    offset,
    sortBy,
    sortDir,
    search,
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

  // Export reuses the existing async CSV job. The AppSync `onNotify` WebSocket is
  // the fast path; polling for a new log file is the reliable backstop and an
  // overall timeout guarantees the button never spins forever.
  const { data: chatlogs, refetch: refetchLogs } = useChatlogs(courseId)
  const { subscribe, close } = useJobNotification()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)

  // Timers live in refs so a re-render can't strand them and unmount can clean up.
  const pollRef = useRef(null)
  const timeoutRef = useRef(null)
  const clearTimers = () => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    pollRef.current = null
    timeoutRef.current = null
  }
  useEffect(() => clearTimers, [])

  const handleExport = async () => {
    setExportError(null)
    setExporting(true)
    clearTimers()
    const requestId = crypto.randomUUID()
    // Baseline: the newest existing log. A file newer than this = our export.
    const baselineLog = Array.isArray(chatlogs) && chatlogs.length ? chatlogs[0].name : null

    // Idempotent terminal step — whichever of {onNotify, poll, timeout} fires
    // first wins; the rest become no-ops. `finally` guarantees the spinner clears.
    let settled = false
    const finish = async ({ error, email } = {}) => {
      if (settled) return
      settled = true
      clearTimers()
      close?.()
      try {
        if (error) {
          setExportError(error)
          return
        }
        const { data: logs } = await refetchLogs()
        const newest = Array.isArray(logs) && logs.length ? logs[0] : null
        if (newest?.url) window.open(newest.url, "_blank")
        // Best-effort cleanup of the completed-notification row.
        if (email) {
          try {
            await http.del("instructor/remove_completed_notification", {
              course_id: courseId,
              instructor_email: email,
            })
          } catch {
            // best-effort
          }
        }
      } finally {
        setExporting(false)
      }
    }

    try {
      const { email } = await http.getAuth()

      // Fast path (best-effort): the realtime completion notification. If the
      // socket errors or never acks, the poll below still completes the export.
      subscribe(requestId, {
        onNotify: () => finish({ email }),
        onError: () => {
          /* swallow — the polling backstop drives completion */
        },
      }).catch(() => {
        /* subscribe rejected (e.g. realtime unavailable) — polling covers it */
      })

      await http.post(
        "instructor/course_messages",
        {},
        { course_id: courseId, instructor_email: email, request_id: requestId }
      )

      // Backstop: poll for a newly-generated log file (the worker uploads the CSV
      // and flips the DB completion flag before it notifies, so this is reliable).
      pollRef.current = setInterval(async () => {
        try {
          const { data: logs } = await refetchLogs()
          const newest = Array.isArray(logs) && logs.length ? logs[0] : null
          if (newest && newest.name !== baselineLog) finish({ email })
        } catch {
          // transient read error — keep polling
        }
      }, EXPORT_POLL_INTERVAL_MS)

      // Ceiling: stop waiting and tell the user instead of spinning forever.
      timeoutRef.current = setTimeout(
        () =>
          finish({
            error:
              "The export is taking longer than expected. Your file may still finish — check the chat logs shortly, or try again.",
          }),
        EXPORT_TIMEOUT_MS
      )
    } catch (err) {
      // getAuth or the job submission itself failed — nothing was started.
      settled = true
      clearTimers()
      close?.()
      setExporting(false)
      setExportError(toUserMessage(err))
    }
  }

  // Only gate on an in-flight export in THIS session. We deliberately do NOT gate
  // on the server's `check_notifications_status` (isEnabled): that flag is false
  // whenever any chatlogs_notifications row exists, and an export that never runs
  // its cleanup (a crash, a missed notification, a DLQ'd job) orphans a row and
  // permanently disables the button. The backend tolerates concurrent jobs (each
  // writes its own timestamped CSV), and a successful export's cleanup deletes any
  // orphaned rows, so a session-scoped guard is both sufficient and self-healing.
  const exportDisabled = exporting

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

  // A truly empty course (no messages, no active search) gets the full empty
  // state. When a search is active we keep the search bar + table so a
  // zero-result search can be cleared (SortableTable shows its no-match row).
  if (total === 0 && !hasSearch) {
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
      <div className="flex items-center gap-4">
        <Searchbar
          value={search}
          // Searching re-filters the whole result set, so reset to the first page.
          onChange={(v) => {
            setSearch(v)
            setPage(0)
          }}
          placeholder="Search chat history"
          className="flex-1"
        />
        {/* Matches the admin "Add course" action (outline, sm, h-7 rounded-sm
            px-6) — Export CSV just omits the trailing icon. */}
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-sm px-6"
          onClick={handleExport}
          loading={exporting}
          disabled={exportDisabled}
        >
          Export CSV
        </Button>
      </div>

      {exportError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{exportError}</AlertDescription>
        </Alert>
      )}

      <SortableTable
        table={table}
        page={page}
        pageCount={pageCount}
        onPageChange={setPage}
        total={total}
        emptyMessage="No messages match your search."
      />
    </div>
  )
}
