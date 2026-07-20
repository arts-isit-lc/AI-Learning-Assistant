import { useReducer, useCallback, useEffect, useRef } from "react"
import apiClient from "@/services/api"
import {
  POLLING_INTERVAL_MS,
  POLLING_TIMEOUT_SECONDS,
  NOT_FOUND_GRACE_PERIOD_MS,
  NOT_FOUND_WARNING_THRESHOLD_MS,
  POLLING_ACTIVE_STATUSES,
} from "@/constants/uploadConfig"

// Ported from the legacy hook — polls the batch file-processing endpoint and
// derives not_found / timed_out per file. Imperative (interval-driven), so it
// lives as a feature hook rather than a Query.
const initialState = { trackedFiles: {}, isPolling: false }

function pollerReducer(state, action) {
  switch (action.type) {
    case "ADD_TRACKED_FILES": {
      const newFiles = {}
      action.payload.files.forEach(({ fileId, uploadCompletedAt }) => {
        if (!state.trackedFiles[fileId]) {
          newFiles[fileId] = {
            fileId,
            status: "pending",
            chunkCount: null,
            lastProcessedAt: null,
            uploadCompletedAt: uploadCompletedAt || Date.now(),
            pollingStartedAt: Date.now(),
          }
        }
      })
      return { ...state, trackedFiles: { ...state.trackedFiles, ...newFiles }, isPolling: true }
    }
    case "UPDATE_STATUSES": {
      const { responseFiles } = action.payload
      const now = Date.now()
      const responseMap = new Map(responseFiles.map((f) => [f.file_id, f]))
      const updated = { ...state.trackedFiles }

      Object.keys(updated).forEach((fileId) => {
        const tracked = updated[fileId]
        const fromServer = responseMap.get(fileId)

        if (fromServer) {
          const elapsedMs = now - tracked.pollingStartedAt
          const isTimedOut = elapsedMs > POLLING_TIMEOUT_SECONDS * 1000
          let newStatus = fromServer.processing_status
          if (isTimedOut && newStatus !== "complete" && newStatus !== "failed") {
            newStatus = "timed_out"
          }
          updated[fileId] = {
            ...tracked,
            status: newStatus,
            chunkCount: fromServer.chunk_count,
            lastProcessedAt: fromServer.last_processed_at,
          }
        } else {
          const elapsedMs = now - tracked.pollingStartedAt
          const isTimedOut = elapsedMs > POLLING_TIMEOUT_SECONDS * 1000
          if (isTimedOut) {
            updated[fileId] = { ...tracked, status: "timed_out" }
          } else if (tracked.status !== "timed_out") {
            updated[fileId] = { ...tracked, status: "not_found" }
          }
        }
      })

      const shouldPoll = Object.values(updated).some((f) =>
        POLLING_ACTIVE_STATUSES.includes(f.status)
      )
      return { ...state, trackedFiles: updated, isPolling: shouldPoll }
    }
    case "REMOVE_TRACKED_FILE": {
      // eslint-disable-next-line no-unused-vars
      const { [action.payload.fileId]: _removed, ...remaining } = state.trackedFiles
      const shouldPoll = Object.values(remaining).some((f) =>
        POLLING_ACTIVE_STATUSES.includes(f.status)
      )
      return { ...state, trackedFiles: remaining, isPolling: shouldPoll }
    }
    case "STOP_POLLING":
      return { ...state, isPolling: false }
    default:
      return state
  }
}

/** Polls file processing statuses; manages per-file state + not_found/timed_out. */
export function useProcessingPoller({ moduleId, enabled = true }) {
  const [state, dispatch] = useReducer(pollerReducer, initialState)
  const intervalRef = useRef(null)
  const consecutiveErrors = useRef(0)

  const poll = useCallback(async () => {
    if (!moduleId) return
    try {
      const data = await apiClient.get("instructor/file_processing_statuses", { module_id: moduleId })
      consecutiveErrors.current = 0
      dispatch({ type: "UPDATE_STATUSES", payload: { responseFiles: data.files || [] } })
    } catch (err) {
      consecutiveErrors.current += 1
      if (consecutiveErrors.current >= 3) {
        console.error("Polling failed 3 times consecutively:", err.message)
      }
    }
  }, [moduleId])

  useEffect(() => {
    if (state.isPolling && enabled && moduleId) {
      poll()
      intervalRef.current = setInterval(poll, POLLING_INTERVAL_MS)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [state.isPolling, enabled, moduleId, poll])

  const addTrackedFiles = useCallback((files) => {
    dispatch({ type: "ADD_TRACKED_FILES", payload: { files } })
  }, [])

  const removeTrackedFile = useCallback((fileId) => {
    dispatch({ type: "REMOVE_TRACKED_FILE", payload: { fileId } })
  }, [])

  const getNotFoundContext = useCallback(
    (fileId) => {
      const tracked = state.trackedFiles[fileId]
      if (!tracked || tracked.status !== "not_found") return null
      const elapsed = Date.now() - tracked.uploadCompletedAt
      if (elapsed < NOT_FOUND_GRACE_PERIOD_MS) return "waiting"
      if (elapsed > NOT_FOUND_WARNING_THRESHOLD_MS) return "warning"
      return "waiting"
    },
    [state.trackedFiles]
  )

  const loadInitialStatuses = useCallback(async () => {
    if (!moduleId) return
    try {
      const data = await apiClient.get("instructor/file_processing_statuses", { module_id: moduleId })
      const inProgressFiles = (data.files || [])
        .filter((f) => f.processing_status === "pending" || f.processing_status === "processing")
        .map((f) => ({ fileId: f.file_id, uploadCompletedAt: Date.now() }))
      if (inProgressFiles.length > 0) {
        dispatch({ type: "ADD_TRACKED_FILES", payload: { files: inProgressFiles } })
      }
    } catch (err) {
      console.error("Failed to load initial file statuses:", err.message)
    }
  }, [moduleId])

  return {
    trackedFiles: state.trackedFiles,
    isPolling: state.isPolling,
    addTrackedFiles,
    removeTrackedFile,
    getNotFoundContext,
    loadInitialStatuses,
  }
}
