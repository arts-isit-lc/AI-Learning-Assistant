import { useState, useEffect, useCallback } from "react"
import apiClient from "@/services/api"

/**
 * Draft-module lifecycle for the create wizard (ported from the legacy hook —
 * imperative, not Query-cacheable, same rationale as useChatStream).
 *
 * On mount: reuse a sessionStorage draft or POST instructor/reserve_module to
 * reserve a module_id (so files can upload before Save). `cleanup()` releases an
 * abandoned draft (POST instructor/cleanup_module); `markSaved()` suppresses
 * cleanup after finalize. A best-effort keepalive fetch cleans up on tab close.
 *
 * @param {string} courseId
 */
export function useDraftModule(courseId) {
  const sessionKey = `draft_module_${courseId}`

  const [moduleId, setModuleId] = useState(() => sessionStorage.getItem(sessionKey) || null)
  const [isReserving, setIsReserving] = useState(false)
  const [reserveError, setReserveError] = useState(null)
  const [isSaved, setIsSaved] = useState(false)

  useEffect(() => {
    if (!courseId) return
    if (moduleId) return

    const reserve = async () => {
      setIsReserving(true)
      setReserveError(null)
      try {
        const { email } = await apiClient.getAuth()
        const result = await apiClient.post("instructor/reserve_module", {
          course_id: courseId,
          instructor_email: email,
        })
        setModuleId(result.module_id)
        sessionStorage.setItem(sessionKey, result.module_id)
      } catch (err) {
        console.error("Failed to reserve draft module:", err.message)
        setReserveError(err.message || "Failed to reserve module. Please try again.")
      } finally {
        setIsReserving(false)
      }
    }

    reserve()
  }, [courseId, moduleId, sessionKey])

  const cleanup = useCallback(async () => {
    if (!moduleId || isSaved) return
    try {
      const { email } = await apiClient.getAuth()
      await apiClient.post("instructor/cleanup_module", {
        module_id: moduleId,
        course_id: courseId,
        instructor_email: email,
      })
    } catch (err) {
      console.warn("Cleanup request failed (non-critical):", err.message)
    } finally {
      sessionStorage.removeItem(sessionKey)
      setModuleId(null)
    }
  }, [moduleId, courseId, isSaved, sessionKey])

  const markSaved = useCallback(() => {
    setIsSaved(true)
    sessionStorage.removeItem(sessionKey)
  }, [sessionKey])

  const clearDraft = useCallback(() => {
    sessionStorage.removeItem(sessionKey)
    setModuleId(null)
    setReserveError(null)
  }, [sessionKey])

  // Best-effort cleanup on browser close/navigate (keepalive fetch — supports
  // auth headers, unlike sendBeacon).
  useEffect(() => {
    if (!moduleId || isSaved) return

    const handleBeforeUnload = async () => {
      if (!moduleId || isSaved) return
      try {
        const { token } = await apiClient.getAuth()
        const url = new URL(`${import.meta.env.VITE_API_ENDPOINT}instructor/cleanup_module`)
        url.searchParams.set("module_id", moduleId)
        url.searchParams.set("course_id", courseId)
        fetch(url.toString(), {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          keepalive: true,
        })
      } catch {
        // Best-effort only — the orphan job is the backstop.
      }
      sessionStorage.removeItem(sessionKey)
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [moduleId, courseId, isSaved, sessionKey])

  return { moduleId, isReserving, reserveError, cleanup, markSaved, clearDraft }
}
