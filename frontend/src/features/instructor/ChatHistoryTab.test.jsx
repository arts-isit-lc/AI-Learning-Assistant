import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const { useCourseMessages, subscribe, http } = vi.hoisted(() => ({
  useCourseMessages: vi.fn(),
  subscribe: vi.fn(),
  http: { getAuth: vi.fn(), post: vi.fn(), del: vi.fn() },
}))

let logsResult
let statusResult
vi.mock("@/services/queries", () => ({
  useCourseMessages: (...args) => useCourseMessages(...args),
  useChatlogs: () => logsResult,
  useChatlogStatus: () => statusResult,
}))
vi.mock("@/services/http", () => ({ http }))
vi.mock("./hooks/useJobNotification", () => ({ useJobNotification: () => ({ subscribe }) }))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useParams: () => ({ courseId: "c1" }) }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { ChatHistoryTab } from "./ChatHistoryTab"

const MSG = (over = {}) => ({
  user_email: "stu@x.com",
  module_name: "vectors",
  concept_name: "algebra",
  session_id: "s1",
  session_name: "Session 1",
  student_sent: true,
  message_content: "what is a vector?",
  time_sent: "2026-02-01T10:00:00Z",
  ...over,
})

beforeEach(() => {
  logsResult = { data: [], refetch: vi.fn().mockResolvedValue({ data: [] }) }
  statusResult = { data: { isEnabled: true } }
  subscribe.mockReset().mockResolvedValue(undefined)
  http.getAuth.mockReset().mockResolvedValue({ email: "prof@x.com" })
  http.post.mockReset().mockResolvedValue({})
  http.del.mockReset().mockResolvedValue({})
  useCourseMessages.mockReset().mockReturnValue({
    data: { messages: [], total: 0 },
    isLoading: false,
    isError: false,
  })
})

describe("ChatHistoryTab", () => {
  it("renders the message table (User/Module/Concept/Session/Message + sender)", () => {
    useCourseMessages.mockReturnValue({
      data: { messages: [MSG(), MSG({ student_sent: false, message_content: "A vector has magnitude." })], total: 2 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)

    expect(screen.getByText("User")).toBeInTheDocument()
    expect(screen.getByText("Module name")).toBeInTheDocument()
    expect(screen.getAllByText("stu@x.com")).toHaveLength(2) // one per row
    expect(screen.getAllByText("Vectors")).toHaveLength(2) // title-cased module
    expect(screen.getByText(/what is a vector\?/)).toBeInTheDocument()
    // sender prefix distinguishes student vs assistant messages
    expect(screen.getByText("Student:")).toBeInTheDocument()
    expect(screen.getByText("OCELIA:")).toBeInTheDocument()
  })

  it("paginates over offset (Previous disabled on page 1, Next advances)", async () => {
    useCourseMessages.mockImplementation((_courseId, { offset }) =>
      offset === 0
        ? { data: { messages: [MSG({ message_content: "page one msg" })], total: 120 }, isLoading: false, isError: false }
        : { data: { messages: [MSG({ message_content: "page two msg" })], total: 120 }, isLoading: false, isError: false }
    )
    render(<ChatHistoryTab />)

    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument() // ceil(120/50)
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled()
    expect(screen.getByText(/page one msg/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument()
    expect(screen.getByText(/page two msg/)).toBeInTheDocument()
    expect(useCourseMessages).toHaveBeenLastCalledWith("c1", { limit: 50, offset: 50 })
  })

  it("exports via the async job (subscribe before submit)", async () => {
    useCourseMessages.mockReturnValue({
      data: { messages: [MSG()], total: 1 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }))

    await waitFor(() => expect(http.post).toHaveBeenCalled())
    expect(subscribe).toHaveBeenCalled()
    expect(http.post).toHaveBeenCalledWith(
      "instructor/course_messages",
      {},
      expect.objectContaining({ course_id: "c1", instructor_email: "prof@x.com" })
    )
  })

  it("shows the empty state when there are no messages", () => {
    render(<ChatHistoryTab />)
    expect(screen.getByRole("heading", { name: "No chat history yet" })).toBeInTheDocument()
  })

  it("shows an error alert when messages fail to load", () => {
    useCourseMessages.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    render(<ChatHistoryTab />)
    expect(screen.getByText("Couldn’t load chat history")).toBeInTheDocument()
  })
})
