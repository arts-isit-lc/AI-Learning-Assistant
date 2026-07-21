import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { http, parseWith } from "../http"
import { queryKeys } from "../queryKeys"
import { ChatLogsSchema, ChatlogStatusSchema, CourseMessagesSchema } from "../schemas/instructor"

/**
 * Course-wide chat messages for the in-app Chat History table (GET
 * instructor/course_messages_rows → B5). Paginated (limit/offset); returns
 * `{ messages, total, limit, offset }`. `keepPreviousData` holds the current
 * page visible while the next one loads, so paging doesn't flash empty.
 * @param {string} courseId
 * @param {{ limit?: number, offset?: number }} [opts]
 */
export function useCourseMessages(courseId, { limit = 50, offset = 0 } = {}) {
  return useQuery({
    queryKey: queryKeys.instructor.courseMessages(courseId, limit, offset),
    enabled: Boolean(courseId),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("instructor/course_messages_rows", {
        course_id: courseId,
        instructor_email: email,
        limit,
        offset,
      })
      return parseWith(CourseMessagesSchema, data ?? {}, "course messages")
    },
  })
}

/** Parse the "YYYY-MM-DD HH:MM:SS.csv" file name (UTC) into a local date string. */
function chatlogDate(fileName) {
  const match = fileName.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (!match) return fileName
  const [, y, mo, d, h, mi, s] = match.map(Number)
  const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return Number.isNaN(utc.getTime()) ? fileName : utc.toLocaleString()
}

/**
 * Generated chat-log files for a course (GET instructor/fetch_chatlogs) →
 * normalized to `[{ name, url, date }]`, newest first. Refetched every 5 minutes
 * because the presigned download URLs expire.
 */
export function useChatlogs(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.chatlogs(courseId),
    enabled: Boolean(courseId),
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("instructor/fetch_chatlogs", {
        course_id: courseId,
        instructor_email: email,
      })
      const parsed = parseWith(ChatLogsSchema, data ?? {}, "chat logs")
      const files = Object.entries(parsed.log_files ?? {}).map(([name, url]) => ({
        name,
        url,
        date: chatlogDate(name),
      }))
      // File names are timestamps, so a reverse lexical sort is newest-first.
      return files.sort((a, b) => b.name.localeCompare(a.name))
    },
  })
}

/**
 * Chat-log generation availability (GET instructor/check_notifications_status).
 * `isEnabled` gates the Generate button (a job isn't already running).
 */
export function useChatlogStatus(courseId) {
  return useQuery({
    queryKey: queryKeys.instructor.chatlogStatus(courseId),
    enabled: Boolean(courseId),
    queryFn: async () => {
      const { email } = await http.getAuth()
      const data = await http.get("instructor/check_notifications_status", {
        course_id: courseId,
        instructor_email: email,
      })
      return parseWith(ChatlogStatusSchema, data ?? {}, "chatlog status")
    },
  })
}
