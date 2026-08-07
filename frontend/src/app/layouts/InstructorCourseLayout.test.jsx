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
    // The copy control uses the brand primary colour (#6829C2 = text-primary),
    // darkening to #2E0666 (primary-dark) on hover.
    expect(screen.getByRole("button", { name: /copy access code/i })).toHaveClass(
      "text-primary",
      "hover:text-primary-dark"
    )
  })

  it("gives inactive section tabs the top-nav styling incl. every state: purple text, rounded brand hover (bg #F2E8FF / text #2E0666), and the #AA78F0 press", () => {
    renderLayout() // Settings is active here → inactive styling applies to the other four.
    for (const name of ["Configuration", "Insights", "Chat history", "Students"]) {
      const tab = screen.getByRole("link", { name })
      expect(tab).toHaveClass("text-primary")
      expect(tab).toHaveClass("hover:bg-primary-subtle")
      expect(tab).toHaveClass("hover:text-primary-dark")
      expect(tab).toHaveClass("rounded")
      // Pressed state must match the top nav (was previously missing here).
      expect(tab).toHaveClass("active:bg-primary-active", "active:text-primary-dark")
    }
  })

  it("marks the active section tab black (#000 / neutral-900) with a 3px border-primary underline and no fill/hover/press, matching the top nav", () => {
    renderLayout()
    const active = screen.getByRole("link", { name: "Settings" })
    // 3px underline (border-b-[3px]) matches InstructorTabBar exactly (was border-b-2).
    expect(active).toHaveClass("border-b-[3px]", "border-primary", "text-neutral-900")
    expect(active).not.toHaveClass("rounded")
    expect(active).not.toHaveClass("hover:bg-primary-subtle")
    expect(active).not.toHaveClass("hover:text-primary-dark")
    expect(active).not.toHaveClass("active:bg-primary-active")
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

  it("renders a neutral 'Course' header when the course isn't in the list (loaded, not found)", () => {
    coursesResult = { data: [], isLoading: false }
    renderLayout()
    expect(screen.getByRole("heading", { name: "Course" })).toBeInTheDocument()
  })

  it("skeletons the course code/name header while the list loads, keeping the tabs + active tab usable", () => {
    coursesResult = { data: [], isLoading: true }
    renderLayout()
    // The course identity is a labelled skeleton — no stale "Course" placeholder.
    expect(screen.getByRole("status", { name: /loading course/i })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Course" })).not.toBeInTheDocument()
    // Section tabs + the active tab (Outlet) stay usable and load independently.
    expect(screen.getByRole("link", { name: "Configuration" })).toBeInTheDocument()
    expect(screen.getByText("settings tab")).toBeInTheDocument()
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

  it("shows a revert signal when the active-toggle update fails", () => {
    updateAccess.isError = true
    renderLayout()
    expect(screen.getByRole("alert")).toHaveTextContent(/reverted/i)
    updateAccess.isError = false
  })
})
