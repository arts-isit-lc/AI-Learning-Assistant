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

  // Regression: the toggle used to be rendered in two different slots (top-right
  // when expanded, inline with the tabs when collapsed), so it teleported on
  // every click and lost focus. It now lives in one fixed, always-rendered
  // container of its OWN — sharing no wrapper with the greeting text or tabs.
  it("puts the toggle in its own container, separate from the greeting, when expanded", () => {
    renderAt("/instructor/courses") // expanded
    const greeting = document.getElementById("instructor-greeting")
    const nav = screen.getByRole("navigation", { name: /instructor navigation/i })
    const toggle = screen.getByRole("button", { name: /collapse/i })
    const heading = screen.getByRole("heading", { name: /hi, instructor/i })
    // The toggle is not inside the greeting container, nor the tab row…
    expect(greeting).not.toContainElement(toggle)
    expect(nav.parentElement).not.toContainElement(toggle)
    // …and the greeting text is not inside the toggle's own container.
    expect(toggle.parentElement).not.toContainElement(heading)
  })

  it("keeps the toggle visible in its own container when collapsed (inside a course)", () => {
    renderAt("/instructor/courses/c1/configuration") // collapsed
    const greeting = document.getElementById("instructor-greeting")
    const toggle = screen.getByRole("button", { name: /expand/i })
    expect(toggle).toBeInTheDocument()
    expect(greeting).not.toContainElement(toggle)
  })

  it("toggles in place: the same button element keeps focus across collapse (no remount/jump)", async () => {
    const user = userEvent.setup()
    renderAt("/instructor/courses") // expanded
    const collapseBtn = screen.getByRole("button", { name: /collapse/i })
    await user.click(collapseBtn)
    const expandBtn = screen.getByRole("button", { name: /expand/i })
    // One stable slot means it's the SAME DOM node, just relabeled — so focus
    // stays on it instead of dropping to <body> when it was re-created elsewhere.
    expect(expandBtn).toBe(collapseBtn)
    expect(expandBtn).toHaveFocus()
  })
})
