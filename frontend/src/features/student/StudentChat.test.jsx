import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"

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
vi.mock("@/services/queries", () => ({
  useModuleSessions: () => sessionsResult,
  useSessionMessages: () => ({
    data: [{ message_id: "m1", message_content: "Hello student", student_sent: false }],
    isLoading: false,
  }),
  useCoursePage: () => ({
    data: [{ module_id: "mod1", module_name: "week 1 intro", concept_id: "c1", concept_name: "Maps" }],
  }),
  useModuleFiles: () => ({ data: [], isLoading: false }),
  useCourses: () => ({
    data: [{ course_id: "c1", course_department: "geog", course_number: "412", course_name: "water" }],
  }),
  useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteLastMessage: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ isInstructorAsStudent: false }) }))
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

  it("reduces/expands the header — the Learning Journey bar slides away (hidden from AT) and back", async () => {
    const user = userEvent.setup()
    renderChat()

    // Expanded: the Learning Journey bar and its drawer control are available.
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()

    // Reduce → the bar collapses and drops out of the accessibility tree (its
    // edge-to-edge rule persists via the full-bleed wrapper).
    await user.click(screen.getByRole("button", { name: /reduce/i }))
    expect(screen.queryByRole("button", { name: /learning journey/i })).not.toBeInTheDocument()

    // Expand → the bar returns.
    await user.click(screen.getByRole("button", { name: /expand/i }))
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()
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
