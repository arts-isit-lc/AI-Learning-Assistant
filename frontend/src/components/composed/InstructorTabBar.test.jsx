import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { InstructorTabBar } from "./InstructorTabBar"

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <InstructorTabBar />
    </MemoryRouter>
  )
}

describe("InstructorTabBar", () => {
  it("renders the three instructor tabs as links", () => {
    renderAt("/instructor/courses")
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Global Analytics" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Global Chats" })).toBeInTheDocument()
  })

  it("is expanded (greeting shown) on the courses landing", () => {
    renderAt("/instructor/courses")
    expect(screen.getByRole("heading", { name: /hi, instructor/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /collapse/i })).toBeInTheDocument()
  })

  it("auto-collapses (greeting hidden) inside a course", () => {
    renderAt("/instructor/courses/c1/configuration")
    expect(screen.queryByRole("heading", { name: /hi, instructor/i })).toBeNull()
    expect(screen.getByRole("button", { name: /expand/i })).toBeInTheDocument()
    // tabs still present
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
  })

  it("lets the instructor collapse the expanded bar manually", async () => {
    const user = userEvent.setup()
    renderAt("/instructor/courses")
    expect(screen.getByRole("heading", { name: /hi, instructor/i })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /collapse/i }))
    expect(screen.queryByRole("heading", { name: /hi, instructor/i })).toBeNull()
    expect(screen.getByRole("button", { name: /expand/i })).toBeInTheDocument()
  })
})
