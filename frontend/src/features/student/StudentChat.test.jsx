import { describe, it, expect, vi } from "vitest"
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

vi.mock("@/services/queries", () => ({
  useModuleSessions: () => ({
    data: [{ session_id: "s1", session_name: "First chat" }],
    isLoading: false,
    isSuccess: true,
  }),
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

describe("StudentChat page", () => {
  it("wires the sidebar (module + session), thread, and input", () => {
    renderChat()
    expect(screen.getByRole("heading", { name: "Week 1 Intro" })).toBeInTheDocument()
    expect(screen.getByText("First chat")).toBeInTheDocument()
    expect(screen.getByText("Hello student")).toBeInTheDocument()
    expect(screen.getByLabelText("Message OCELIA Assistant")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /new chat/i })).toBeInTheDocument()
  })

  it("swaps the Learning Journey bar for a full-bleed divider when the header is reduced", async () => {
    const user = userEvent.setup()
    renderChat()

    // Expanded: the Learning Journey bar carries the divider — no stand-in rule.
    expect(screen.getByText("Learning Journey")).toBeInTheDocument()
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()

    // Reduce → the bar is hidden and the stand-in divider takes its place.
    await user.click(screen.getByRole("button", { name: /reduce/i }))
    expect(screen.queryByText("Learning Journey")).not.toBeInTheDocument()
    expect(screen.getByRole("separator")).toBeInTheDocument()

    // Expand → back to the bar, divider removed.
    await user.click(screen.getByRole("button", { name: /expand/i }))
    expect(screen.getByText("Learning Journey")).toBeInTheDocument()
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
  })
})
