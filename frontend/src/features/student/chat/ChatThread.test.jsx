import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatThread } from "./ChatThread"

const messages = [
  { message_id: "1", message_content: "Hi there", student_sent: false },
  { message_id: "2", message_content: "My question", student_sent: true },
]

describe("ChatThread", () => {
  it("renders AI and student messages", () => {
    render(<ChatThread messages={messages} />)
    expect(screen.getByText("Hi there")).toBeInTheDocument()
    expect(screen.getByText("My question")).toBeInTheDocument()
  })

  it("renders the streaming message", () => {
    render(<ChatThread messages={[]} streamingText="streaming reply" />)
    expect(screen.getByText("streaming reply")).toBeInTheDocument()
  })

  it("shows the typing indicator when typing and not streaming", () => {
    render(<ChatThread messages={[]} isTyping />)
    expect(screen.getByRole("status", { name: "AI is typing" })).toBeInTheDocument()
  })

  it("shows a retry banner on error", () => {
    render(<ChatThread messages={[]} retryError={{}} onRetry={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })
})
