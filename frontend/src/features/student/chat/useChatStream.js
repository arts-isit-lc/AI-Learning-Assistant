import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import apiClient from "@/services/api"
import { queryKeys } from "@/services/queryKeys"
import { titleCase } from "@/utils/formatters"

// Backstop for the authoritative stream terminator: if the terminal (done)
// message never arrives (Lambda died / network dropped), surface the retry
// banner instead of hanging. Above the chatbot Lambda's 120s timeout.
const WATCHDOG_MS = 130000

// AWSJSON blocks arrive over the subscription as a JSON string; the POST
// fallback delivers them as an array. Accept either (guard double-encoding).
function parseBlocks(blocks) {
  if (!blocks) return null
  try {
    let parsed = typeof blocks === "string" ? JSON.parse(blocks) : blocks
    if (typeof parsed === "string") parsed = JSON.parse(parsed)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Chat streaming for one module, reconciled with the TanStack Query cache.
 *
 * Delivery model (Option B, ported from the legacy `useChatSession` verbatim in
 * contract): the AppSync WebSocket stream is AUTHORITATIVE. `POST student/chatbot-v2`
 * is a fire-and-forget trigger — on a slow (multi-image) turn it times out at API
 * Gateway's 29s cap while the Lambda keeps running and streams the answer. The
 * turn is finalized from the terminal stream message OR the POST JSON (whichever
 * arrives first — `finalizeTurn` is idempotent), or a watchdog error.
 *
 * Transient state (`streamingText`, the optimistic student bubble) is local; the
 * FINAL message is written into `useSessionMessages`' cache via `setQueryData`,
 * so persisted history and the live turn stay consistent. `chatbot-v2` +
 * best-effort side effects go through `apiClient` directly (fire-and-forget
 * streaming triggers, not cacheable data — deliberate exception to the Query rule).
 */
export function useChatStream({ courseId, moduleId }) {
  const queryClient = useQueryClient()
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [retryError, setRetryError] = useState(null)
  const [activeStreamSessionId, setActiveStreamSessionId] = useState(null)

  const wsRef = useRef(null)
  const watchdogRef = useRef(null)
  const accumulatedTextRef = useRef("")
  const turnCtxRef = useRef(null)
  const finalizedRef = useRef(false)

  const appendMessage = useCallback(
    (sessionId, message) => {
      queryClient.setQueryData(queryKeys.sessions.messages(sessionId), (old) => [
        ...(old || []),
        message,
      ])
    },
    [queryClient]
  )

  const finalizeTurn = useCallback(
    (payload) => {
      if (finalizedRef.current) return
      finalizedRef.current = true

      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current)
        watchdogRef.current = null
      }
      setIsStreaming(false)
      setIsTyping(false)
      setStreamingText("")
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }

      const ctx = turnCtxRef.current || {}

      if (!payload || payload.error) {
        setRetryError({
          sessionId: ctx.sessionId,
          sessionName: ctx.sessionName,
          messageContent: ctx.messageContent ?? null,
          source: ctx.source || "submit",
        })
        return
      }

      const finalText = payload.llm_output ?? accumulatedTextRef.current ?? ""
      const parsed = parseBlocks(payload.blocks)
      const streamedName = payload.session_name
      const autoName =
        streamedName && streamedName !== "New Chat" && streamedName !== "New chat"
          ? streamedName
          : finalText.split(/[.!?]/)[0].substring(0, 30) || "New Chat"

      // Reflect the auto-name in the session list cache.
      queryClient.setQueryData(queryKeys.modules.sessions(courseId, moduleId), (old) =>
        Array.isArray(old)
          ? old.map((s) =>
              s.session_id === ctx.sessionId ? { ...s, session_name: titleCase(autoName) } : s
            )
          : old
      )

      appendMessage(ctx.sessionId, {
        message_id: `ai-${Date.now()}`,
        message_content: finalText,
        blocks: parsed ?? undefined,
        student_sent: false,
        session_id: ctx.sessionId,
        time_sent: new Date().toISOString(),
      })

      // Best-effort side effects — never block rendering.
      apiClient
        .putRaw("student/update_session_name", { session_id: ctx.sessionId }, { session_name: autoName })
        .catch(() => null)
      if (ctx.email) {
        apiClient
          .postRaw("student/update_module_score", {
            module_id: ctx.moduleId,
            student_email: ctx.email,
            course_id: ctx.courseId,
            llm_verdict: payload.llm_verdict,
          })
          .catch(() => null)
      }
    },
    [queryClient, courseId, moduleId, appendMessage]
  )

  const subscribeToChunks = useCallback(
    (turnCtx) => {
      turnCtxRef.current = turnCtx
      accumulatedTextRef.current = ""
      finalizedRef.current = false
      setActiveStreamSessionId(turnCtx.sessionId)
      const sessionId = turnCtx.sessionId
      try {
        const tempUrl = import.meta.env.VITE_GRAPHQL_WS_URL
        if (!tempUrl) return

        const apiUrl = tempUrl.replace("https://", "wss://")
        const urlObj = new URL(apiUrl)
        const tmpObj = new URL(tempUrl)
        urlObj.hostname = urlObj.hostname.replace("appsync-api", "appsync-realtime-api")

        const header = {
          host: tmpObj.hostname,
          Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
        }
        const encodedHeader = btoa(JSON.stringify(header))
        const wsUrl = `${urlObj.toString()}?header=${encodedHeader}&payload=e30=`

        const ws = new WebSocket(wsUrl, "graphql-ws")
        wsRef.current = ws

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "connection_init" }))
          ws.send(
            JSON.stringify({
              id: sessionId,
              type: "start",
              payload: {
                data: JSON.stringify({
                  query: `subscription OnChatChunk($session_id: String!) { onChatChunk(session_id: $session_id) { session_id chunk done llm_output blocks session_name llm_verdict error } }`,
                  variables: { session_id: sessionId },
                }),
                extensions: {
                  authorization: {
                    Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
                    host: tmpObj.hostname,
                  },
                },
              },
            })
          )
          setIsStreaming(true)
          setStreamingText("")
          if (watchdogRef.current) clearTimeout(watchdogRef.current)
          watchdogRef.current = setTimeout(() => finalizeTurn({ error: true }), WATCHDOG_MS)
        }

        ws.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.type === "data" && message.payload?.data?.onChatChunk) {
            const c = message.payload.data.onChatChunk
            if (c.done) {
              finalizeTurn(c)
            } else if (c.chunk) {
              accumulatedTextRef.current += c.chunk
              setStreamingText((prev) => prev + c.chunk)
            }
          }
        }

        ws.onerror = () => {
          setIsStreaming(false)
          if (ws) ws.close()
          wsRef.current = null
        }

        ws.onclose = () => {
          wsRef.current = null
        }
      } catch (e) {
        console.error("Failed to subscribe to chat chunks:", e)
      }
    },
    [finalizeTurn]
  )

  /**
   * Run one chat turn against a session. `messageContent` null = greeting (new
   * chat). `skipOptimistic` avoids re-appending the student bubble on retry.
   */
  const runTurn = useCallback(
    async ({ session, messageContent = null, source = "submit", skipOptimistic = false }) => {
      if (!session?.session_id) return
      setRetryError(null)
      setIsTyping(true)

      let email
      try {
        ;({ email } = await apiClient.getAuth())
      } catch {
        email = undefined
      }

      if (messageContent && !skipOptimistic) {
        appendMessage(session.session_id, {
          message_id: `opt-${Date.now()}`,
          message_content: messageContent,
          student_sent: true,
          session_id: session.session_id,
          time_sent: new Date().toISOString(),
        })
      }

      subscribeToChunks({
        sessionId: session.session_id,
        sessionName: session.session_name,
        messageContent,
        source,
        email,
        courseId,
        moduleId,
      })

      apiClient
        .postRaw(
          "student/chatbot-v2",
          {
            course_id: courseId,
            session_id: session.session_id,
            module_id: moduleId,
            session_name: session.session_name,
          },
          messageContent ? { message_content: messageContent } : undefined
        )
        .then((resp) => (resp.ok ? resp.json() : null))
        .then((data) => {
          if (data) finalizeTurn(data)
        })
        .catch(() => null)
    },
    [courseId, moduleId, appendMessage, subscribeToChunks, finalizeTurn]
  )

  const retry = useCallback(() => {
    if (!retryError) return
    const ctx = retryError
    setRetryError(null)
    runTurn({
      session: { session_id: ctx.sessionId, session_name: ctx.sessionName },
      messageContent: ctx.messageContent,
      source: ctx.source,
      skipOptimistic: true,
    })
  }, [retryError, runTurn])

  useEffect(
    () => () => {
      if (wsRef.current) wsRef.current.close()
      if (watchdogRef.current) clearTimeout(watchdogRef.current)
    },
    []
  )

  return {
    streamingText,
    isStreaming,
    isTyping,
    retryError,
    activeStreamSessionId,
    runTurn,
    retry,
  }
}
