import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionSidebar } from "./SessionSidebar"

const sessions = [
  { session_id: "s1", session_name: "First" },
  { session_id: "s2", session_name: "Second" },
]

describe("SessionSidebar", () => {
  it("renders the module title and session list", () => {
    render(<SessionSidebar moduleName="Week 1" sessions={sessions} activeSessionId="s2" />)
    expect(screen.getByRole("heading", { name: "Week 1" })).toBeInTheDocument()
    expect(screen.getByText("First")).toBeInTheDocument()
    expect(screen.getByText("Second")).toBeInTheDocument()
  })

  it("fires onNew from the New chat button", async () => {
    const onNew = vi.fn()
    render(<SessionSidebar moduleName="Week 1" sessions={sessions} onNew={onNew} />)
    await userEvent.click(screen.getByRole("button", { name: /new chat/i }))
    expect(onNew).toHaveBeenCalledOnce()
  })

  it("disables New chat while creating", () => {
    render(<SessionSidebar moduleName="Week 1" sessions={sessions} onNew={() => {}} creating />)
    expect(screen.getByRole("button", { name: /new chat/i })).toBeDisabled()
  })
})
