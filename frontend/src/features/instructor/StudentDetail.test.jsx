import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let messagesResult
vi.mock("@/services/queries", () => ({
  useStudentMessages: () => messagesResult,
}))

import { StudentDetail } from "./StudentDetail"

const HISTORY = {
  Vectors: [
    {
      sessionName: "Chat 1",
      messages: [
        { student_sent: true, message_content: "what is a vector" },
        { student_sent: false, message_content: "STUDENT ACHIEVED COMPETENCY nicely done" },
      ],
    },
  ],
}

beforeEach(() => {
  messagesResult = { data: HISTORY, isLoading: false, isError: false }
})

describe("StudentDetail", () => {
  it("shows the student header and a tab per module", () => {
    render(<StudentDetail courseId="c1" email="ada@x.com" name="Ada Lovelace" onBack={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument()
    expect(screen.getByText("ada@x.com")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Vectors" })).toBeInTheDocument()
  })

  it("reveals messages and highlights the mastery marker when a session is expanded", async () => {
    render(<StudentDetail courseId="c1" email="ada@x.com" name="Ada" onBack={vi.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: "Chat 1" }))
    expect(await screen.findByText("what is a vector")).toBeInTheDocument()
    expect(screen.getByText("STUDENT ACHIEVED COMPETENCY")).toBeInTheDocument()
  })

  it("calls onBack from the back button", async () => {
    const onBack = vi.fn()
    render(<StudentDetail courseId="c1" email="ada@x.com" onBack={onBack} />)
    await userEvent.click(screen.getByRole("button", { name: /back to students/i }))
    expect(onBack).toHaveBeenCalled()
  })

  it("shows an empty state when the student has no chat history", () => {
    messagesResult = { data: {}, isLoading: false, isError: false }
    render(<StudentDetail courseId="c1" email="ada@x.com" onBack={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "No chat history" })).toBeInTheDocument()
  })
})
