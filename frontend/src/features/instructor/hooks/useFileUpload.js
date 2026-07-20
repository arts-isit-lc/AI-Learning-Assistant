import { useReducer, useCallback, useRef } from "react"
import apiClient from "@/services/api"
import { XHR_UPLOAD_TIMEOUT_MS } from "@/constants/uploadConfig"
import { cleanFileName, removeFileExtension, getFileType } from "@/utils/fileHelpers"

// Ported from the legacy hook — presigned-URL upload via a raw XHR (progress +
// abort), which isn't Query-cacheable (same feature-hook exception as streaming).
const initialState = { files: {} } // Map<fileId, fileState>

function uploadReducer(state, action) {
  switch (action.type) {
    case "ADD_FILE":
      return {
        ...state,
        files: {
          ...state.files,
          [action.payload.fileId]: {
            fileId: action.payload.fileId,
            fileName: action.payload.fileName,
            status: "uploading",
            progress: 0,
            error: null,
            uploadStartedAt: Date.now(),
          },
        },
      }
    case "UPDATE_PROGRESS":
      return {
        ...state,
        files: {
          ...state.files,
          [action.payload.fileId]: {
            ...state.files[action.payload.fileId],
            progress: action.payload.progress,
          },
        },
      }
    case "UPLOAD_SUCCESS":
      return {
        ...state,
        files: {
          ...state.files,
          [action.payload.fileId]: {
            ...state.files[action.payload.fileId],
            status: "upload_complete",
            progress: 100,
          },
        },
      }
    case "UPLOAD_FAILED":
      return {
        ...state,
        files: {
          ...state.files,
          [action.payload.fileId]: {
            ...state.files[action.payload.fileId],
            status: "upload_failed",
            error: action.payload.error,
          },
        },
      }
    case "REMOVE_FILE": {
      // eslint-disable-next-line no-unused-vars
      const { [action.payload.fileId]: _removed, ...remaining } = state.files
      return { ...state, files: remaining }
    }
    case "RESET_FILE":
      return {
        ...state,
        files: {
          ...state.files,
          [action.payload.fileId]: {
            ...state.files[action.payload.fileId],
            status: "uploading",
            progress: 0,
            error: null,
            uploadStartedAt: Date.now(),
          },
        },
      }
    default:
      return state
  }
}

/**
 * XHR-based file upload with progress. Returns per-file state + controls.
 * @param {{ courseId: string, moduleId: string, moduleName: string }} options
 */
export function useFileUpload({ courseId, moduleId, moduleName }) {
  const [state, dispatch] = useReducer(uploadReducer, initialState)
  const xhrRefs = useRef({})

  const uploadFile = useCallback(
    async (file) => {
      const fileType = getFileType(file.name)
      const fileName = cleanFileName(removeFileExtension(file.name))

      let presignedUrl, fileId, contentType
      try {
        const response = await apiClient.get("instructor/generate_presigned_url", {
          course_id: courseId,
          module_id: moduleId,
          module_name: moduleName,
          file_type: fileType,
          file_name: fileName,
        })
        presignedUrl = response.presignedurl
        fileId = response.file_id
        contentType = response.content_type
      } catch (err) {
        throw new Error(`Failed to get upload URL: ${err.message}`)
      }

      if (!fileId) fileId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`

      dispatch({ type: "ADD_FILE", payload: { fileId, fileName: file.name } })

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhrRefs.current[fileId] = xhr

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100)
            dispatch({ type: "UPDATE_PROGRESS", payload: { fileId, progress } })
          }
        }
        xhr.onload = () => {
          delete xhrRefs.current[fileId]
          if (xhr.status >= 200 && xhr.status < 300) {
            dispatch({ type: "UPLOAD_SUCCESS", payload: { fileId } })
            resolve({ fileId, fileName: file.name })
          } else {
            const error = `Upload failed with status ${xhr.status}`
            dispatch({ type: "UPLOAD_FAILED", payload: { fileId, error } })
            reject(new Error(error))
          }
        }
        xhr.onerror = () => {
          delete xhrRefs.current[fileId]
          const error = "Network error during upload"
          dispatch({ type: "UPLOAD_FAILED", payload: { fileId, error } })
          reject(new Error(error))
        }
        xhr.ontimeout = () => {
          delete xhrRefs.current[fileId]
          const error = "Upload timed out"
          dispatch({ type: "UPLOAD_FAILED", payload: { fileId, error } })
          reject(new Error(error))
        }

        xhr.open("PUT", presignedUrl)
        xhr.timeout = XHR_UPLOAD_TIMEOUT_MS
        xhr.setRequestHeader("Content-Type", contentType || file.type || "application/octet-stream")
        xhr.send(file)
      })
    },
    [courseId, moduleId, moduleName]
  )

  const uploadFiles = useCallback(
    async (files) => {
      const results = []
      const promises = files.map(async (file) => {
        try {
          results.push(await uploadFile(file))
        } catch (err) {
          console.error(`Upload failed for ${file.name}:`, err.message)
        }
      })
      await Promise.all(promises)
      return results
    },
    [uploadFile]
  )

  const abortFile = useCallback((fileId) => {
    const xhr = xhrRefs.current[fileId]
    if (xhr) {
      xhr.abort()
      delete xhrRefs.current[fileId]
    }
    dispatch({ type: "REMOVE_FILE", payload: { fileId } })
  }, [])

  const removeFile = useCallback((fileId) => {
    const xhr = xhrRefs.current[fileId]
    if (xhr) {
      xhr.abort()
      delete xhrRefs.current[fileId]
    }
    dispatch({ type: "REMOVE_FILE", payload: { fileId } })
  }, [])

  const retryFile = useCallback(
    async (fileId, file) => {
      dispatch({ type: "RESET_FILE", payload: { fileId } })
      return uploadFile(file)
    },
    [uploadFile]
  )

  return { fileStates: state.files, uploadFiles, uploadFile, abortFile, removeFile, retryFile }
}
