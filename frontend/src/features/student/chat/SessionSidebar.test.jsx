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

  it("lists module materials by filename, not the file_id", () => {
    // student/files returns "Module_Files" rows: { file_id, filename, filetype }.
    const files = [{ file_id: "0e4b-uuid", filename: "syllabus.pdf", filetype: "pdf" }]
    render(
      <SessionSidebar moduleName="Week 1" sessions={sessions} files={files} materialsOpen />
    )
    expect(screen.getByText("syllabus.pdf")).toBeInTheDocument()
    expect(screen.queryByText("0e4b-uuid")).not.toBeInTheDocument()
  })

  it("hides materials from assistive tech when collapsed (Collapse stays mounted for the slide)", () => {
    const files = [{ file_id: "0e4b-uuid", filename: "syllabus.pdf", filetype: "pdf" }]
    render(
      <SessionSidebar moduleName="Week 1" sessions={sessions} files={files} materialsOpen={false} />
    )
    // The panel stays mounted so it can animate, but is aria-hidden while
    // collapsed, so the file button isn't reachable by role.
    expect(screen.queryByRole("button", { name: /syllabus\.pdf/i })).not.toBeInTheDocument()
  })

  it("announces a loading region for the session list while sessions load", () => {
    render(<SessionSidebar moduleName="Week 1" sessions={[]} loading />)
    expect(screen.getByRole("status", { name: /loading chats/i })).toBeInTheDocument()
  })

  it("announces a loading region for materials while files load (materials open)", () => {
    render(<SessionSidebar moduleName="Week 1" sessions={sessions} filesLoading materialsOpen />)
    expect(screen.getByRole("status", { name: /loading materials/i })).toBeInTheDocument()
  })
})
