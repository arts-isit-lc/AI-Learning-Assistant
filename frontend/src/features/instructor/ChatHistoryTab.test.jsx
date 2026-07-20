import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let logsResult
let statusResult
const { subscribe, http } = vi.hoisted(() => ({
  subscribe: vi.fn(),
  http: { getAuth: vi.fn(), post: vi.fn(), del: vi.fn() },
}))

vi.mock("@/services/queries", () => ({
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

beforeEach(() => {
  logsResult = { data: [], isLoading: false, refetch: vi.fn() }
  statusResult = { data: { isEnabled: true }, refetch: vi.fn() }
  subscribe.mockReset().mockResolvedValue(undefined)
  http.getAuth.mockReset().mockResolvedValue({ email: "prof@x.com" })
  http.post.mockReset().mockResolvedValue({})
  http.del.mockReset().mockResolvedValue({})
})

describe("ChatHistoryTab", () => {
  it("lists generated logs with a download action", () => {
    logsResult = {
      data: [{ name: "2026-02-01 10:00:00.csv", url: "https://s3/log.csv", date: "Feb 1, 2026, 10:00 AM" }],
      isLoading: false,
      refetch: vi.fn(),
    }
    render(<ChatHistoryTab />)
    expect(screen.getByText("Feb 1, 2026, 10:00 AM")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument()
  })

  it("subscribes before submitting the generation job", async () => {
    render(<ChatHistoryTab />)
    await userEvent.click(screen.getByRole("button", { name: "Generate chat logs" }))
    await waitFor(() => expect(http.post).toHaveBeenCalled())
    expect(subscribe).toHaveBeenCalled()
    expect(http.post).toHaveBeenCalledWith(
      "instructor/course_messages",
      {},
      expect.objectContaining({ course_id: "c1", instructor_email: "prof@x.com" })
    )
  })

  it("shows the empty state when there are no logs", () => {
    render(<ChatHistoryTab />)
    expect(screen.getByRole("heading", { name: "No chat logs yet" })).toBeInTheDocument()
  })
})
