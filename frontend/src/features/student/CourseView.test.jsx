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
  it("renders the course title, concept, and module statuses (expanded)", () => {
    renderCourse()
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    expect(screen.getByText(/week 1/i)).toBeInTheDocument()
    expect(screen.getByText(/week 2/i)).toBeInTheDocument()
    // Module completion is now a status circle (icon with an accessible label).
    expect(screen.getByLabelText("Complete")).toBeInTheDocument()
    expect(screen.getByLabelText("Not complete")).toBeInTheDocument()
  })

  it("offers the Learning journey drawer", () => {
    renderCourse()
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()
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
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Concepts" })).toBeInTheDocument()

    // Expand → the Learning Journey bar returns.
    await userEvent.click(screen.getByRole("button", { name: /expand$/i }))
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeInTheDocument()
  })

  it("toggles Expand all / Collapse all — Expand all active (bold + primary) by default", async () => {
    renderCourse()
    const expandBtn = screen.getByRole("button", { name: "Expand all" })
    const collapseBtn = screen.getByRole("button", { name: "Collapse all" })

    // Default: Expand all is the active option (bold + primary); Collapse all is
    // inactive (normal weight + #808080 = text-neutral-500).
    expect(expandBtn).toHaveAttribute("aria-pressed", "true")
    expect(expandBtn).toHaveClass("font-semibold", "text-primary")
    expect(collapseBtn).toHaveAttribute("aria-pressed", "false")
    expect(collapseBtn).toHaveClass("font-normal", "text-neutral-500")

    // Clicking Collapse all flips the active option.
    await userEvent.click(collapseBtn)
    expect(collapseBtn).toHaveAttribute("aria-pressed", "true")
    expect(collapseBtn).toHaveClass("font-semibold", "text-primary")
    expect(expandBtn).toHaveAttribute("aria-pressed", "false")
    expect(expandBtn).toHaveClass("font-normal", "text-neutral-500")
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
    expect(screen.getByText(/week 1/i)).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load this course" })).not.toBeInTheDocument()
  })
})
