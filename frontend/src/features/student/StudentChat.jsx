import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { MdFolderOpen } from "react-icons/md"
import { toast } from "react-toastify"
import {
  useModuleSessions,
  useSessionMessages,
  useCoursePage,
  useModuleFiles,
  useCreateSession,
  useDeleteSession,
  useDeleteLastMessage,
} from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { FileRow } from "@/components/composed/FileRow"
import { EmptyState } from "@/components/composed/EmptyState"
import { SessionSidebar } from "./chat/SessionSidebar"
import { ChatThread } from "./chat/ChatThread"
import { ChatInput } from "./chat/ChatInput"
import { useChatStream } from "./chat/useChatStream"
import { ReferenceDocPanel } from "./ReferenceDocPanel"

/**
 * Student module chat. Composes the chat components + the Phase 3 data hooks +
 * `useChatStream` (AppSync streaming). States (OQ-13): intro (auto-created first
 * session greeting) · mid-conversation · slide-in materials drawer (Sheet) ·
 * reference-doc panel (?doc=:fileId). Route: /courses/:courseId/modules/:moduleId.
 */
export function StudentChat() {
  const { courseId, moduleId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const docId = searchParams.get("doc")

  // Sessions created this mount: their greeting streams into the cache, so we
  // must NOT fetch their (empty) server history and clobber it.
  const createdRef = useRef(new Set())
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [materialsOpen, setMaterialsOpen] = useState(false)

  const sessionsQuery = useModuleSessions(courseId, moduleId)
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data])
  const coursePage = useCoursePage(courseId)
  const files = useModuleFiles(courseId, moduleId)
  const stream = useChatStream({ courseId, moduleId })
  const createSession = useCreateSession(courseId, moduleId)
  const deleteSession = useDeleteSession(courseId, moduleId)
  const deleteLastMessage = useDeleteLastMessage(activeSessionId)

  const messagesQuery = useSessionMessages(activeSessionId, {
    enabled: Boolean(activeSessionId) && !createdRef.current.has(activeSessionId),
  })
  const messages = messagesQuery.data ?? []

  const moduleName = useMemo(() => {
    const row = coursePage.data?.find((r) => r.module_id === moduleId)
    return row ? titleCase(row.module_name) : "Module"
  }, [coursePage.data, moduleId])

  const activeSession = sessions.find((s) => s.session_id === activeSessionId) || null
  const creating = createSession.isPending

  function startNewChat() {
    if (creating) return
    createSession.mutate("New chat", {
      onSuccess: (session) => {
        createdRef.current.add(session.session_id)
        setActiveSessionId(session.session_id)
        stream.runTurn({ session, messageContent: null, source: "newChat" })
      },
      onError: () => toast.error("Couldn't start a new chat."),
    })
  }

  // Default to the most-recent session once they load.
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      setActiveSessionId(sessions[sessions.length - 1].session_id)
    }
  }, [sessions, activeSessionId])

  // Auto-create a first session (with greeting) when the module has none.
  useEffect(() => {
    if (sessionsQuery.isSuccess && sessions.length === 0 && !creating) {
      startNewChat()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQuery.isSuccess, sessions.length])

  const handleSubmit = (text) => {
    if (activeSession) stream.runTurn({ session: activeSession, messageContent: text })
  }

  const handleDeleteSession = (session) => {
    deleteSession.mutate(session.session_id, {
      onSuccess: () => {
        if (session.session_id === activeSessionId) setActiveSessionId(null)
      },
    })
  }

  const openDoc = (fileId) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set("doc", fileId)
        return next
      },
      { replace: true }
    )
    setMaterialsOpen(false)
  }
  const closeDoc = () =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("doc")
        return next
      },
      { replace: true }
    )

  // Delete affordance = most-recent student message that has an AI reply after it.
  const studentIndices = messages.map((m, i) => (m.student_sent ? i : -1)).filter((i) => i >= 0)
  const mostRecentStudentIndex = studentIndices.length ? studentIndices[studentIndices.length - 1] : -1
  const hasAiMessageAfter =
    mostRecentStudentIndex >= 0 &&
    messages.slice(mostRecentStudentIndex + 1).some((m) => !m.student_sent)

  const isActiveStreaming = stream.activeStreamSessionId === activeSessionId
  const streamingText = isActiveStreaming ? stream.streamingText : ""
  const isTyping = isActiveStreaming ? stream.isTyping : false
  const inputDisabled = isTyping || (isActiveStreaming && stream.isStreaming) || creating

  const selectedFile = files.data?.find((f) => f.file_id === docId)

  return (
    // Fill the viewport below the AppHeader (h-16 = 4rem) so the thread scrolls.
    <div className="flex h-[calc(100vh-4rem)]">
      <SessionSidebar
        moduleName={moduleName}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelect={(s) => setActiveSessionId(s.session_id)}
        onNew={startNewChat}
        onDelete={handleDeleteSession}
        onBack={() => navigate(`/courses/${courseId}`)}
        creating={creating}
        loading={sessionsQuery.isLoading}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <h1 className="text-h4 font-semibold text-navy">AI Assistant</h1>
          <Sheet open={materialsOpen} onOpenChange={setMaterialsOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Icon icon={MdFolderOpen} size={18} />
                Materials
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              <SheetHeader>
                <SheetTitle>Module materials</SheetTitle>
              </SheetHeader>
              <div className="mt-4 flex flex-col gap-2 overflow-y-auto">
                {files.isLoading ? (
                  [0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)
                ) : files.data?.length ? (
                  files.data.map((file) => (
                    <FileRow key={file.file_id} file={file} onClick={() => openDoc(file.file_id)} />
                  ))
                ) : (
                  <EmptyState title="No materials" description="This module has no reference files." />
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>

        <ChatThread
          messages={messages}
          streamingText={streamingText}
          isTyping={isTyping}
          retryError={stream.retryError}
          onRetry={stream.retry}
          mostRecentStudentIndex={mostRecentStudentIndex}
          hasAiMessageAfter={hasAiMessageAfter}
          onDeleteMessage={() => activeSessionId && deleteLastMessage.mutate()}
          loading={messagesQuery.isLoading}
        />

        <div className="border-t border-border px-6 py-4">
          <ChatInput onSubmit={handleSubmit} disabled={inputDisabled} />
        </div>
      </div>

      {docId && (
        <div className="hidden w-2/5 shrink-0 lg:block">
          <ReferenceDocPanel fileId={docId} fileName={selectedFile?.file_name} onClose={closeDoc} />
        </div>
      )}
    </div>
  )
}
