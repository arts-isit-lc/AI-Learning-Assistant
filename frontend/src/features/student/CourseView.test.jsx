import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
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
})
