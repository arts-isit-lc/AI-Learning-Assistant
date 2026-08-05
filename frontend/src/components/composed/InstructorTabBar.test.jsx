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
    }
  })

  it("marks the active tab black (#000 / neutral-900) with a border-primary underline and no hover, matching admin", () => {
    renderAt("/instructor/courses")
    const active = screen.getByRole("link", { name: "Courses" })
    expect(active).toHaveClass("border-primary", "text-neutral-900")
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

  // Regression: the toggle used to be rendered in two different slots (top-right
  // when expanded, inline with the tabs when collapsed), so it teleported on
  // every click and lost focus. It now lives in one stable slot — the tab row.
  it("anchors the toggle beside the tabs (same row) when expanded, so it doesn't jump", () => {
    renderAt("/instructor/courses") // expanded
    const nav = screen.getByRole("navigation", { name: /instructor navigation/i })
    const toggle = screen.getByRole("button", { name: /collapse/i })
    // Same parent element = same row: the toggle sits next to the tabs, not in a
    // separate top-right slot next to the greeting.
    expect(toggle.parentElement).toBe(nav.parentElement)
  })

  it("keeps the toggle in that same tab row when collapsed", () => {
    renderAt("/instructor/courses/c1/configuration") // collapsed
    const nav = screen.getByRole("navigation", { name: /instructor navigation/i })
    const toggle = screen.getByRole("button", { name: /expand/i })
    expect(toggle.parentElement).toBe(nav.parentElement)
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
