import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"

let coursesResult
let promptResult
let accessCodeResult
const updateAccess = { mutate: vi.fn(), isPending: false }
const deleteCourse = { mutate: vi.fn(), isPending: false }
vi.mock("@/services/queries", () => ({
  useInstructorCourses: () => coursesResult,
  useCoursePrompt: () => promptResult,
  useAccessCode: () => accessCodeResult,
  useUpdateInstructorCourseAccess: () => updateAccess,
  useDeleteInstructorCourse: () => deleteCourse,
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
  updateAccess.mutate.mockClear()
  deleteCourse.mutate.mockClear()
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

  it("toggles course Active/Inactive from the header switch (B7)", async () => {
    renderLayout()
    await userEvent.click(screen.getByRole("switch", { name: /course active/i }))
    expect(updateAccess.mutate).toHaveBeenCalled()
  })

  it("deletes the course after confirmation (B7)", async () => {
    renderLayout()
    await userEvent.click(screen.getByRole("button", { name: "Delete course" }))
    const confirm = screen
      .getAllByRole("dialog")
      .find((d) => within(d).queryByText("Delete course?"))
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete course" }))
    expect(deleteCourse.mutate).toHaveBeenCalled()
  })
})
