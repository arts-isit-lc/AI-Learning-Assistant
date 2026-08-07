import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router"

const stream = {
  streamingText: "",
  isStreaming: false,
  isTyping: false,
  retryError: null,
  activeStreamSessionId: null,
  runTurn: vi.fn(),
  retry: vi.fn(),
}

let sessionsResult
let coursePageResult
vi.mock("@/services/queries", () => ({
  useModuleSessions: () => sessionsResult,
  useSessionMessages: () => ({
    data: [{ message_id: "m1", message_content: "Hello student", student_sent: false }],
    isLoading: false,
  }),
  useCoursePage: () => coursePageResult,
  useModuleFiles: () => ({ data: [], isLoading: false }),
  useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteLastMessage: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock("./chat/useChatStream", () => ({ useChatStream: () => stream }))

import { StudentChat } from "./StudentChat"

function renderChat() {
  return render(
    <MemoryRouter initialEntries={["/courses/c1/modules/mod1"]}>
      <Routes>
        <Route path="/courses/:courseId/modules/:moduleId" element={<StudentChat />} />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  sessionsResult = {
    data: [{ session_id: "s1", session_name: "First chat" }],
    isLoading: false,
    isSuccess: true,
    isError: false,
  }
  coursePageResult = {
    data: [{ module_id: "mod1", module_name: "week 1 intro", concept_id: "c1", concept_name: "Maps" }],
    isLoading: false,
  }
})

describe("StudentChat page", () => {
  it("wires the sidebar (module + session), thread, and input", () => {
    renderChat()
    expect(screen.getByRole("heading", { name: "Week 1 Intro" })).toBeInTheDocument()
    expect(screen.getByText("First chat")).toBeInTheDocument()
    expect(screen.getByText("Hello student")).toBeInTheDocument()
    expect(screen.getByLabelText("Message OCELIA Assistant")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument()
  })

  it("no course header or Learning Journey bar — full vertical space for the chatbot", () => {
    renderChat()
    expect(screen.queryByRole("link", { name: /courses/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /reduce/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /expand/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /learning journey/i })).not.toBeInTheDocument()
  })

  it("shows an accessible ErrorState with retry when the session list fails to load", async () => {
    const refetch = vi.fn()
    sessionsResult = { data: undefined, isLoading: false, isSuccess: false, isError: true, error: { status: 500 }, refetch }
    renderChat()
    expect(screen.getByRole("heading", { name: "Couldn't load this chat" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → chat)", async () => {
    const refetch = vi.fn()
    sessionsResult = { data: undefined, isLoading: false, isSuccess: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = renderChat()
    expect(screen.getByRole("heading", { name: "Couldn't load this chat" })).toBeInTheDocument()
    sessionsResult = {
      data: [{ session_id: "s1", session_name: "First chat" }],
      isLoading: false,
      isSuccess: true,
      isError: false,
    }
    rerender(
      <MemoryRouter initialEntries={["/courses/c1/modules/mod1"]}>
        <Routes>
          <Route path="/courses/:courseId/modules/:moduleId" element={<StudentChat />} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByText("First chat")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load this chat" })).not.toBeInTheDocument()
  })
})
