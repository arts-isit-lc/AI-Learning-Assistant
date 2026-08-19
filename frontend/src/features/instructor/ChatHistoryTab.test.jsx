import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
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
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useParams: () => ({ courseId: "c1" }) }
})

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

  it("requests the first page (20 rows) sorted by the User column ascending by default", () => {
    useCourseMessages.mockReturnValue({
      data: { messages: [MSG()], total: 95 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)
    expect(useCourseMessages).toHaveBeenLastCalledWith(
      "c1",
      { limit: 20, offset: 0, sortBy: "user_email", sortDir: "asc" }
    )
  })

  it("shows a 'Displaying N out of TOTAL results' count and renders the Export CSV toolbar above the table", () => {
    useCourseMessages.mockReturnValue({
      data: { messages: Array.from({ length: 20 }, () => MSG()), total: 95 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)
    expect(screen.getByText("Displaying 20 out of 95 results")).toBeInTheDocument()
    // Export button sits before the table in DOM order (top toolbar, not footer).
    const exportBtn = screen.getByRole("button", { name: "Export CSV" })
    const table = screen.getByRole("table")
    expect(exportBtn.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("paginates over offset via the numbered pagination (Previous disabled on page 1, page click advances)", async () => {
    useCourseMessages.mockImplementation((_courseId, { offset }) =>
      offset === 0
        ? { data: { messages: [MSG({ message_content: "page one msg" })], total: 95 }, isLoading: false, isError: false }
        : { data: { messages: [MSG({ message_content: "page two msg" })], total: 95 }, isLoading: false, isError: false }
    )
    render(<ChatHistoryTab />)

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByText(/page one msg/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Page 2" }))
    expect(screen.getByText(/page two msg/)).toBeInTheDocument()
    expect(useCourseMessages).toHaveBeenLastCalledWith(
      "c1",
      { limit: 20, offset: 20, sortBy: "user_email", sortDir: "asc" }
    )
  })

  it("toggles the active column's direction, sorts a new column ascending, and resets to page 1 on sort", async () => {
    useCourseMessages.mockReturnValue({
      data: { messages: [MSG()], total: 95 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)

    // Clicking the already-ascending User column flips it to descending.
    await userEvent.click(screen.getByRole("button", { name: "User" }))
    expect(useCourseMessages).toHaveBeenLastCalledWith(
      "c1",
      { limit: 20, offset: 0, sortBy: "user_email", sortDir: "desc" }
    )

    // Move off page 1, then changing the sort column must snap back to offset 0
    // (the old offset is meaningless against a freshly-ordered result set).
    await userEvent.click(screen.getByRole("button", { name: "Page 3" }))
    expect(useCourseMessages).toHaveBeenLastCalledWith(
      "c1",
      { limit: 20, offset: 40, sortBy: "user_email", sortDir: "desc" }
    )
    await userEvent.click(screen.getByRole("button", { name: "Concept" }))
    expect(useCourseMessages).toHaveBeenLastCalledWith(
      "c1",
      { limit: 20, offset: 0, sortBy: "concept_name", sortDir: "asc" }
    )
  })

  it("shows a short message in full with no '...Show more' link", () => {
    useCourseMessages.mockReturnValue({
      data: { messages: [MSG({ message_content: "short and sweet" })], total: 1 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)
    expect(screen.getByText(/short and sweet/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument()
  })

  it("previews a long message (250 chars) with '...Show more' that opens the full text in a footer-less modal", async () => {
    // > 250 chars; the FINALMARKER tail lands past the preview cut-off.
    const longBody = "Intro. " + "lorem ".repeat(60) + "FINALMARKER."
    useCourseMessages.mockReturnValue({
      data: { messages: [MSG({ message_content: longBody })], total: 1 },
      isLoading: false,
      isError: false,
    })
    render(<ChatHistoryTab />)

    // The tail is hidden in the collapsed preview until expanded.
    expect(screen.queryByText(/FINALMARKER/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /show more/i }))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/FINALMARKER/)).toBeInTheDocument()
    // No footer/action buttons — the modal's only control is the close X.
    const buttons = within(dialog).getAllByRole("button")
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAccessibleName("Close")
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

  it("shows the empty state when there are no messages, styled like the Configuration placeholder (muted fill, no border)", () => {
    render(<ChatHistoryTab />)
    const heading = screen.getByRole("heading", { name: "No chat history yet" })
    expect(heading).toBeInTheDocument()
    expect(heading.closest("div")).toHaveClass("border-0", "bg-muted")
  })

  it("shows the block skeleton loader (no table or pagination chrome) while messages load", () => {
    useCourseMessages.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    render(<ChatHistoryTab />)
    expect(screen.getByRole("status", { name: /loading chat history/i })).toBeInTheDocument()
    // Block skeleton replaces the whole table + pagination footer while loading.
    expect(screen.queryByRole("columnheader", { name: "User" })).not.toBeInTheDocument()
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument()
  })

  it("shows an accessible ErrorState with retry when messages fail to load", async () => {
    const refetch = vi.fn()
    useCourseMessages.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch })
    render(<ChatHistoryTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load chat history" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → table)", async () => {
    const refetch = vi.fn()
    useCourseMessages.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch })
    const { rerender } = render(<ChatHistoryTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load chat history" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    useCourseMessages.mockReturnValue({ data: { messages: [MSG()], total: 1 }, isLoading: false, isError: false })
    rerender(<ChatHistoryTab />)
    expect(screen.getByText("Module name")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load chat history" })).not.toBeInTheDocument()
  })
})
