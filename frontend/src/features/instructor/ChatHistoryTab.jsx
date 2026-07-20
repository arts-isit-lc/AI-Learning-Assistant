import { useState } from "react"
import { useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { useChatlogs, useChatlogStatus } from "@/services/queries"
import { http } from "@/services/http"
import { useJobNotification } from "./hooks/useJobNotification"
import { DataTable } from "@/components/composed/DataTable"
import { EmptyState } from "@/components/composed/EmptyState"
import { Button } from "@/components/ui/button"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { MdForum } from "react-icons/md"

/**
 * Chat History tab — generate + download the course chat-log export. Generation
 * opens the AppSync `onNotify` subscription first, THEN submits the job (so the
 * completion event can't be missed), and refreshes the list on notify.
 *
 * NOTE: this ships the degraded CSV-download experience. The in-app row table +
 * Excel export depend on backend track B5 (rows-as-JSON + server-side .xlsx) and
 * slot in here once B5 lands — the CSV download works in the meantime.
 */
export function ChatHistoryTab() {
  const { courseId } = useParams()
  const { data: logs = [], isLoading, refetch } = useChatlogs(courseId)
  const { data: status, refetch: refetchStatus } = useChatlogStatus(courseId)
  const { subscribe } = useJobNotification()
  const [generating, setGenerating] = useState(false)

  const disabled = generating || status?.isEnabled === false

  const handleGenerate = async () => {
    setGenerating(true)
    const requestId = crypto.randomUUID()
    try {
      const { email } = await http.getAuth()
      // Subscribe first; the promise resolves once the subscription is live.
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
          refetch()
          refetchStatus()
          setGenerating(false)
          toast.success("Chat logs are ready to download")
        },
      })
      // Subscription confirmed — submit the job.
      await http.post(
        "instructor/course_messages",
        {},
        { course_id: courseId, instructor_email: email, request_id: requestId }
      )
      toast.info("Generating chat logs — you'll be notified when they're ready.")
    } catch {
      setGenerating(false)
      toast.error("Couldn't start chat-log generation")
    }
  }

  const columns = [
    { accessorKey: "date", header: "Generated" },
    {
      id: "download",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => window.open(row.original.url, "_blank")}>
            Download CSV
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-h4 font-semibold text-navy">Chat history</h2>
        <Button onClick={handleGenerate} loading={generating} disabled={disabled}>
          Generate chat logs
        </Button>
      </div>

      <Alert variant="info">
        <AlertTitle>Downloads as CSV</AlertTitle>
        <AlertDescription>
          An in-app table and Excel export are coming soon. For now, generated logs download as CSV.
        </AlertDescription>
      </Alert>

      {!isLoading && logs.length === 0 ? (
        <EmptyState
          icon={MdForum}
          title="No chat logs yet"
          description="Generate a chat-log export to download this course's conversations."
        />
      ) : (
        <DataTable columns={columns} data={logs} loading={isLoading} emptyMessage="No chat logs yet." />
      )}
    </div>
  )
}
