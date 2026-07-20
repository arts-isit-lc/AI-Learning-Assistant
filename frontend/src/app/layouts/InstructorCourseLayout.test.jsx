import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"

let coursesResult
let promptResult
let accessCodeResult
vi.mock("@/services/queries", () => ({
  useInstructorCourses: () => coursesResult,
  useCoursePrompt: () => promptResult,
  useAccessCode: () => accessCodeResult,
}))

import InstructorCourseLayout from "./InstructorCourseLayout"

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/instructor/courses/c1/settings"]}>
      <Routes>
        <Route path="/instructor/courses/:courseId" element={<InstructorCourseLayout />}>
          <Route path="settings" element={<div>settings tab</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  coursesResult = {
    data: [
      { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro" },
    ],
  }
  promptResult = { data: null }
  accessCodeResult = { data: "65XH19000jo12" }
})

describe("InstructorCourseLayout", () => {
  it("shows the course code (heading) + name derived from the instructor course list", () => {
    renderLayout()
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    expect(screen.getByText("Intro")).toBeInTheDocument()
    // the active tab renders through the Outlet
    expect(screen.getByText("settings tab")).toBeInTheDocument()
  })

  it("shows the course access code (with a copy control) in the header", () => {
    renderLayout()
    expect(screen.getByText("65XH19000jo12")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /copy access code/i })).toBeInTheDocument()
  })

  it("flags the Settings tab with a dot when there is an unresolved prompt conflict", () => {
    promptResult = { data: { conflict_metadata: { has_conflicts: true } } }
    renderLayout()
    expect(screen.getByRole("status", { name: "Unresolved prompt conflict" })).toBeInTheDocument()
  })

  it("does not flag the Settings tab when the prompt is conflict-free", () => {
    promptResult = { data: { conflict_metadata: { has_conflicts: false } } }
    renderLayout()
    expect(screen.queryByRole("status", { name: "Unresolved prompt conflict" })).not.toBeInTheDocument()
  })

  it("renders a neutral header while the course list is still loading", () => {
    coursesResult = { data: [] }
    renderLayout()
    expect(screen.getByRole("heading", { name: "Course" })).toBeInTheDocument()
  })
})
