import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "react-toastify"
import {
  useModuleSessions,
  useSessionMessages,
  useCoursePage,
  useCourses,
  useModuleFiles,
  useCreateSession,
  useDeleteSession,
  useDeleteLastMessage,
} from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import { computeConceptProgress } from "@/utils/courseProgress"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { CourseHeader } from "./CourseHeader"
import { LearningJourneyBar } from "./LearningJourneyBar"
import { SessionSidebar } from "./chat/SessionSidebar"
import { ChatThread } from "./chat/ChatThread"
import { ChatInput } from "./chat/ChatInput"
import { useChatStream } from "./chat/useChatStream"
import { ReferenceDocPanel } from "./ReferenceDocPanel"

/**
 * Student module chat — Figma frames 162:3817 / 214:5316 / 209:5164. Embedded
 * under the shared course header + Learning Journey bar (Reduce/Expand collapses
 * them for more room). Left = module + "Previous chats" + "Module materials";
 * right = the "OCELIA ASSISTANT" box (thread + composer); opening a material
 * inserts a reference-doc column between them. Composes the Phase 3 hooks +
 * `useChatStream` (AppSync streaming). Route: /courses/:courseId/modules/:moduleId.
 */
export function StudentChat() {
  const { courseId, moduleId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const docId = searchParams.get("doc")
  const { isInstructorAsStudent } = useAuth()

  // Sessions created this mount: their greeting streams into the cache, so we
  // must NOT fetch their (empty) server history and clobber it.
  const createdRef = useRef(new Set())
  const [activeSessionId, setActiveSessionId] = useState(null)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [headerCollapsed, setHeaderCollapsed] = useState(false)

  const sessionsQuery = useModuleSessions(courseId, moduleId)
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data])
  const coursePage = useCoursePage(courseId)
  const coursesQuery = useCourses({ asInstructor: isInstructorAsStudent })
  const files = useModuleFiles(courseId, moduleId)
  const stream = useChatStream({ courseId, moduleId })
  const createSession = useCreateSession(courseId, moduleId)
  const deleteSession = useDeleteSession(courseId, moduleId)
  const deleteLastMessage = useDeleteLastMessage(activeSessionId)

  const messagesQuery = useSessionMessages(activeSessionId, {
    enabled: Boolean(activeSessionId) && !createdRef.current.has(activeSessionId),
  })
  const messages = messagesQuery.data ?? []

  const course = coursesQuery.data?.find((c) => c.course_id === courseId)
  const { concepts, completedConcepts, totalConcepts, percent } = useMemo(
    () => computeConceptProgress(coursePage.data ?? []),
    [coursePage.data]
  )

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
    <div className="mx-auto flex h-[calc(100vh-5rem)] w-full max-w-7xl flex-col">
      <CourseHeader
        course={course}
        collapsible
        collapsed={headerCollapsed}
        onToggleCollapse={() => setHeaderCollapsed((v) => !v)}
      />
      {!headerCollapsed ? (
        <LearningJourneyBar
          concepts={concepts}
          completedConcepts={completedConcepts}
          totalConcepts={totalConcepts}
          percent={percent}
        />
      ) : (
        // Reduced: the Learning Journey bar — which supplies the full-bleed rule
        // between the top area and the chat — is hidden, so stand in a matching
        // edge-to-edge divider (same w-screen break-out) to keep that separation.
        <div
          role="separator"
          className="relative left-1/2 w-screen -translate-x-1/2 border-b border-border"
        />
      )}

      <div className="mt-6 grid min-h-0 flex-1 grid-cols-3 grid-rows-1 gap-8">
        <div className="flex min-w-0 flex-col">
          <SessionSidebar
            moduleName={moduleName}
            onBack={() => navigate(`/courses/${courseId}`)}
            onNew={startNewChat}
            creating={creating}
            loading={sessionsQuery.isLoading}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelect={(s) => setActiveSessionId(s.session_id)}
            onDelete={handleDeleteSession}
            files={files.data ?? []}
            filesLoading={files.isLoading}
            materialsOpen={materialsOpen}
            onToggleMaterials={() => setMaterialsOpen((v) => !v)}
            activeDocId={docId}
            onOpenDoc={openDoc}
          />
        </div>

        {docId && (
          <div className="hidden min-w-0 lg:flex">
            <ReferenceDocPanel fileId={docId} fileName={selectedFile?.filename} onClose={closeDoc} />
          </div>
        )}

        <div
          className={cn(
            "col-span-2 flex min-w-0 flex-col overflow-hidden rounded-sm border border-border",
            docId && "lg:col-span-1"
          )}
        >
          <h2 className="pt-4 pb-10 text-center text-h4 font-semibold text-neutral-900">
            OCELIA ASSISTANT
          </h2>
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
          <div className="border-t border-border p-4">
            <ChatInput onSubmit={handleSubmit} disabled={inputDisabled} />
          </div>
        </div>
      </div>
    </div>
  )
}
