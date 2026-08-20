import { useState } from "react"
import { useParams } from "react-router"
import { MdForum } from "react-icons/md"
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { useCourseMessages, useChatlogs, useChatlogStatus } from "@/services/queries"
import { http } from "@/services/http"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { useJobNotification } from "./hooks/useJobNotification"
import { EmptyState } from "@/components/composed/EmptyState"
import { Pagination } from "@/components/composed/Pagination"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { toUserMessage } from "@/services/apiError"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
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
 * "...Show more" link that opens the full message in a modal (title + scrollable
 * body, the Dialog's built-in top-right close X, no footer/actions).
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
 * Stacked up/down sort triangles (Figma 376:2331). Both triangles are faded
 * white at rest; the active direction goes solid white (`fill-current` inherits
 * the header's `text-primary-foreground`). Decorative — the column header's
 * `aria-sort` conveys the sort state to assistive tech.
 * @param {{ direction: "asc" | "desc" | false }} props
 */
function SortIndicator({ direction }) {
  return (
    <svg viewBox="0 0 10 14" width="13" height="20" aria-hidden="true" className="shrink-0 fill-current">
      <path d="M5 0 9 5H1z" className={cn(direction === "asc" ? "opacity-100" : "opacity-40")} />
      <path d="M5 14 1 9h8z" className={cn(direction === "desc" ? "opacity-100" : "opacity-40")} />
    </svg>
  )
}

/**
 * Chat History tab — Figma 376:2331. An in-app, course-wide message table
 * (purple header) paginated over the B5 `course_messages_rows` endpoint. Columns
 * are sortable server-side (asc/desc; User is the default) and resizable via
 * drag handles. The "Export CSV" toolbar (top-right) runs the robust async
 * full-course export — the browser only ever holds one page; the complete log is
 * generated server-side to S3.
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

      <div className="overflow-hidden border border-border">
        {/* Always fit the parent (w-full from the primitive). With table-layout
            fixed the per-column sizes act as proportions, so columns shrink to
            the container width instead of forcing the table past its parent. */}
        <Table className="[table-layout:fixed]">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header, i, arr) => {
                  const sorted = header.column.getIsSorted() // "asc" | "desc" | false
                  const label = flexRender(header.column.columnDef.header, header.getContext())
                  return (
                    <TableHead
                      key={header.id}
                      style={{ width: header.getSize() }}
                      aria-sort={
                        sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                      }
                      className={cn(
                        "relative bg-primary font-semibold text-primary-foreground",
                        // Column separator (translucent white to read on purple).
                        i < arr.length - 1 && "border-r border-primary-foreground/20"
                      )}
                    >
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="flex w-full items-center justify-between gap-2 text-left"
                      >
                        <span className="truncate">{label}</span>
                        <SortIndicator direction={sorted} />
                      </button>
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          aria-hidden="true"
                          className={cn(
                            "absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none bg-primary-foreground/20 opacity-0 transition-opacity hover:opacity-100",
                            header.column.getIsResizing() && "bg-primary-foreground/50 opacity-100"
                          )}
                        />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row, rowIndex) => (
              // Zebra striping: odd rows (1st, 3rd, …) get the #F5F5F5 muted fill.
              <TableRow key={row.id} className={cn(rowIndex % 2 === 0 && "bg-muted")}>
                {row.getVisibleCells().map((cell, i, arr) => (
                  <TableCell
                    key={cell.id}
                    style={{ width: cell.column.getSize() }}
                    className={cn(
                      "align-top text-left text-neutral-900",
                      i < arr.length - 1 && "border-r border-border"
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-caption">
          Displaying {messages.length} out of {total} results
        </p>
        <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
      </div>
    </div>
  )
}
