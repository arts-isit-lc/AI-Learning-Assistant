import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
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

  it("gives inactive nav tabs the admin styling: purple text + rounded brand hover (bg #F2E8FF / text #2E0666)", () => {
    renderAt("/instructor/courses")
    // Courses is active here, so the inactive styling applies to the other two.
    for (const name of ["Global Analytics", "Global Chats"]) {
      const tab = screen.getByRole("link", { name })
      expect(tab).toHaveClass("text-primary")
      expect(tab).toHaveClass("hover:bg-primary-subtle")
      expect(tab).toHaveClass("hover:text-primary-dark")
      expect(tab).toHaveClass("rounded")
      // Press (active): #AA78F0 (primary-active) surface + #2E0666 (primary-dark) text.
      expect(tab).toHaveClass("active:bg-primary-active", "active:text-primary-dark")
    }
  })

  it("marks the active tab black (#000 / neutral-900) with a 3px border-primary underline and no fill/hover, matching admin", () => {
    renderAt("/instructor/courses")
    const active = screen.getByRole("link", { name: "Courses" })
    // Selected: #000 text + a 3px #6829C2 underline, no fill or hover/press.
    expect(active).toHaveClass("border-b-[3px]", "border-primary", "text-neutral-900")
    expect(active).not.toHaveClass("rounded")
    expect(active).not.toHaveClass("hover:bg-primary-subtle")
    expect(active).not.toHaveClass("hover:text-primary-dark")
    expect(active).not.toHaveClass("active:bg-primary-active")
  })

  it("always shows the greeting on the courses landing (no expand/collapse toggle)", () => {
    renderAt("/instructor/courses")
    expect(screen.getByRole("heading", { name: /hi, instructor/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /collapse/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull()
  })

  it("keeps the greeting visible inside a course too (no auto-collapse, no toggle)", () => {
    renderAt("/instructor/courses/c1/configuration")
    expect(screen.getByRole("heading", { name: /hi, instructor/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /collapse/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull()
    // Tabs still present.
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
  })
})
