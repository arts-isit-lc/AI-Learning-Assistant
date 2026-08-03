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

  it("gives inactive nav tabs the rounded brand hover state (bg #F2E8FF / text #2E0666)", () => {
    renderAt("/instructor/courses")
    // Courses is active here, so the hover applies only to the other two.
    for (const name of ["Global Analytics", "Global Chats"]) {
      const tab = screen.getByRole("link", { name })
      expect(tab).toHaveClass("hover:bg-primary-subtle")
      expect(tab).toHaveClass("hover:text-primary-dark")
      expect(tab).toHaveClass("rounded")
    }
  })

  it("gives the active tab no hover state and no rounded corners", () => {
    renderAt("/instructor/courses")
    const active = screen.getByRole("link", { name: "Courses" })
    expect(active).toHaveClass("border-primary", "text-primary")
    expect(active).not.toHaveClass("rounded")
    expect(active).not.toHaveClass("hover:bg-primary-subtle")
    expect(active).not.toHaveClass("hover:text-primary-dark")
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

  it("exposes the collapse state via aria-expanded on the toggle (disclosure)", async () => {
    const user = userEvent.setup()
    renderAt("/instructor/courses")
    expect(screen.getByRole("button", { name: /collapse/i })).toHaveAttribute("aria-expanded", "true")
    await user.click(screen.getByRole("button", { name: /collapse/i }))
    expect(screen.getByRole("button", { name: /expand/i })).toHaveAttribute("aria-expanded", "false")
  })
})
