import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { SessionSchema, SessionsSchema, MessagesSchema } from "../schemas/student"

/** Chat sessions for a module (GET student/module). */
export function useModuleSessions(courseId, moduleId) {
  return useQuery({
    queryKey: queryKeys.modules.sessions(courseId, moduleId),
    enabled: Boolean(courseId && moduleId),
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("student/module", {
        email,
        course_id: courseId,
        module_id: moduleId,
      })
      return parseWith(SessionsSchema, data, "module sessions")
    },
  })
}

/**
 * Persisted messages for a session (GET student/get_messages).
 * Pass `{ enabled: false }` for a freshly-created session whose greeting is
 * streaming into the cache — fetching its (empty) history would clobber it.
 * @param {string} sessionId
 * @param {{ enabled?: boolean }} [opts]
 */
export function useSessionMessages(sessionId, { enabled = true } = {}) {
  return useQuery({
    queryKey: queryKeys.sessions.messages(sessionId),
    enabled: Boolean(sessionId) && enabled,
    queryFn: async () => {
      const data = await http.get("student/get_messages", { session_id: sessionId })
      const messages = parseWith(MessagesSchema, data, "session messages")
      // Normalize message_blocks -> blocks for the renderer (matches legacy).
      return messages.map((m) => ({ ...m, blocks: m.message_blocks ?? undefined }))
    },
  })
}

/** Create a new chat session; invalidates the module's session list. */
export function useCreateSession(courseId, moduleId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (sessionName = "New chat") => {
      const { email } = await http.getAuth()
      const data = await http.post("student/create_session", {
        email,
        course_id: courseId,
        module_id: moduleId,
        session_name: sessionName,
      })
      const created = Array.isArray(data) ? data[0] : data
      return parseWith(SessionSchema, created, "created session")
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.modules.sessions(courseId, moduleId) }),
  })
}

/** Delete a chat session; invalidates the module's session list. */
export function useDeleteSession(courseId, moduleId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (sessionId) => {
      const { email } = await http.getAuth()
      await http.del("student/delete_session", {
        email,
        course_id: courseId,
        module_id: moduleId,
        session_id: sessionId,
      })
      return sessionId
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.modules.sessions(courseId, moduleId) }),
  })
}

/**
 * Rename a session — the optimistic-update + rollback exemplar (plan §10). The
 * sidebar name updates immediately; on error the previous cache is restored.
 */
export function useRenameSession(courseId, moduleId) {
  const qc = useQueryClient()
  const key = queryKeys.modules.sessions(courseId, moduleId)
  return useMutation({
    mutationFn: async ({ sessionId, sessionName }) => {
      await http.put("student/update_session_name", { session_id: sessionId }, { session_name: sessionName })
      return { sessionId, sessionName }
    },
    onMutate: async ({ sessionId, sessionName }) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData(key)
      qc.setQueryData(key, (old) =>
        Array.isArray(old)
          ? old.map((s) => (s.session_id === sessionId ? { ...s, session_name: sessionName } : s))
          : old
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  })
}

/** Delete the most recent message pair in a session. */
export function useDeleteLastMessage(sessionId) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      await http.del("student/delete_last_message", { session_id: sessionId })
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: queryKeys.sessions.messages(sessionId) }),
  })
}
