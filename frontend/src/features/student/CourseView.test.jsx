import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { groupConcepts } from "./CourseView"

let coursePage
vi.mock("@/services/queries", () => ({
  useCoursePage: () => coursePage,
  useCourses: () => ({
    data: [{ course_id: "c1", course_department: "geog", course_number: "250", course_name: "intro" }],
  }),
}))
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ isInstructorAsStudent: false }) }))

import { CourseView } from "./CourseView"

const rows = [
  { concept_id: "con1", concept_name: "maps", module_id: "m1", module_name: "week 1", module_score: 100, last_accessed: "2026-01-01" },
  { concept_id: "con1", concept_name: "maps", module_id: "m2", module_name: "week 2", module_score: 0, last_accessed: null },
]

function renderCourse() {
  coursePage = { data: rows, isLoading: false, isError: false }
  return render(
    <MemoryRouter initialEntries={["/courses/c1?expand=1"]}>
      <Routes>
        <Route path="/courses/:courseId" element={<CourseView />} />
      </Routes>
    </MemoryRouter>
  )
}

describe("groupConcepts", () => {
  it("groups modules by concept and averages the scores", () => {
    const grouped = groupConcepts(rows)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].modules).toHaveLength(2)
    expect(grouped[0].average).toBe(50)
  })
})

describe("CourseView", () => {
  it("uses the subtle purple surface when a concept accordion is hovered", () => {
    renderCourse()
    const conceptAccordion = screen.getByRole("button", { name: /maps/i }).parentElement.parentElement
    expect(conceptAccordion).toHaveClass("hover:bg-primary-subtle")
  })

  it("renders the course title, concept, and module statuses (expanded)", async () => {
    renderCourse()
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    // Concepts are collapsed by default — expand them first.
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }))
    expect(screen.getByRole("link", { name: /week 1/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /week 2/i })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Complete" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Not complete" })).toBeInTheDocument()
  })

  it("offers the Learning journey drawer", () => {
    renderCourse()
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()
  })

  it("shows a loading placeholder for progress (not a stale 0%) while the course page loads", () => {
    coursePage = { data: undefined, isLoading: true, isError: false }
    render(
      <MemoryRouter initialEntries={["/courses/c1"]}>
        <Routes>
          <Route path="/courses/:courseId" element={<CourseView />} />
        </Routes>
      </MemoryRouter>
    )
    // The journey bar shows a loading skeleton instead of "0% (0/0 concepts completed)".
    expect(screen.getByRole("status", { name: /loading progress/i })).toBeInTheDocument()
    expect(screen.queryByText(/concepts completed/i)).not.toBeInTheDocument()
  })

  it("Reduce/Expand collapses the header — hides the Learning Journey bar, keeps code + Concepts", async () => {
    renderCourse()

    // Expanded by default: the Reduce toggle and the Learning Journey bar show.
    const reduce = screen.getByRole("button", { name: /reduce/i })
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()

    // Reduce → the Learning Journey bar collapses away; the toggle flips to
    // Expand, and the course code + Concepts stay in view. (/expand$/ avoids the
    // separate "Expand all" concepts control.)
    await userEvent.click(reduce)
    expect(screen.queryByRole("button", { name: /learning journey/i })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /expand$/i })).toBeInTheDocument()
    // Compact code (span) stays in the reduced one-liner; the h1 title is hidden.
    expect(screen.getByText("GEOG 250", { selector: "span" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Concepts" })).toBeInTheDocument()

    // Expand → the Learning Journey bar returns.
    await userEvent.click(screen.getByRole("button", { name: /expand$/i }))
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()
  })

  it("toggles Expand all / Collapse all — Collapse all active by default (all closed on load)", async () => {
    renderCourse()
    const expandBtn = screen.getByRole("button", { name: "Expand all" })
    const collapseBtn = screen.getByRole("button", { name: "Collapse all" })

    // Default: Collapse all is the active option (bold + primary); Expand all is inactive.
    expect(collapseBtn).toHaveAttribute("aria-pressed", "true")
    expect(collapseBtn).toHaveClass("font-semibold", "text-primary")
    expect(expandBtn).toHaveAttribute("aria-pressed", "false")
    expect(expandBtn).toHaveClass("font-normal", "text-neutral-500")

    // Clicking Expand all flips the active option.
    await userEvent.click(expandBtn)
    expect(expandBtn).toHaveAttribute("aria-pressed", "true")
    expect(expandBtn).toHaveClass("font-semibold", "text-primary")
    expect(collapseBtn).toHaveAttribute("aria-pressed", "false")
    expect(collapseBtn).toHaveClass("font-normal", "text-neutral-500")
  })

  it("shows an accessible ErrorState with a working retry when the course fails to load", async () => {
    const refetch = vi.fn()
    coursePage = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(
      <MemoryRouter initialEntries={["/courses/c1"]}>
        <Routes>
          <Route path="/courses/:courseId" element={<CourseView />} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByRole("heading", { name: "Couldn't load this course" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → content)", async () => {
    const refetch = vi.fn()
    coursePage = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(
      <MemoryRouter initialEntries={["/courses/c1"]}>
        <Routes>
          <Route path="/courses/:courseId" element={<CourseView />} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByRole("heading", { name: "Couldn't load this course" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    coursePage = { data: rows, isLoading: false, isError: false }
    rerender(
      <MemoryRouter initialEntries={["/courses/c1"]}>
        <Routes>
          <Route path="/courses/:courseId" element={<CourseView />} />
        </Routes>
      </MemoryRouter>
    )
    // After recovery, expand to verify module links are present.
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }))
    expect(screen.getByRole("link", { name: /week 1/i })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load this course" })).not.toBeInTheDocument()
  })
})
