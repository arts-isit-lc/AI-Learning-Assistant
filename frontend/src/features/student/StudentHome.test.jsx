import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"

let coursesResult
vi.mock("@/services/queries", () => ({
  useCourses: () => coursesResult,
  useCourseProgressSummary: () => ({ data: [], isLoading: false, isError: false }),
  useEnrollCourse: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ isInstructorAsStudent: false }) }))

import { StudentHome } from "./StudentHome"

function renderHome() {
  return render(
    <MemoryRouter>
      <StudentHome />
    </MemoryRouter>
  )
}

beforeEach(() => {
  coursesResult = { data: [], isLoading: false, isError: false }
})

describe("StudentHome", () => {
  it("renders a card per enrolled course", () => {
    coursesResult = {
      data: [
        { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro" },
      ],
      isLoading: false,
      isError: false,
    }
    renderHome()
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
  })

  it("shows the empty state when there are no courses", () => {
    renderHome()
    expect(screen.getByRole("heading", { name: "No courses yet" })).toBeInTheDocument()
  })

  it("opens the join-course dialog from the header action", async () => {
    coursesResult = {
      data: [
        { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro" },
      ],
      isLoading: false,
      isError: false,
    }
    renderHome()
    await userEvent.click(screen.getByRole("button", { name: "Join course" }))
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Join course")
  })

  it("announces a labelled loading region while courses load", () => {
    coursesResult = { data: undefined, isLoading: true, isError: false }
    renderHome()
    expect(screen.getByRole("status", { name: /loading courses/i })).toBeInTheDocument()
  })

  it("shows an accessible ErrorState with a working retry when courses fail to load", async () => {
    const refetch = vi.fn()
    coursesResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    renderHome()
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Couldn't load your courses" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → content)", async () => {
    const refetch = vi.fn()
    coursesResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = renderHome()
    expect(screen.getByRole("heading", { name: "Couldn't load your courses" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    coursesResult = {
      data: [{ course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro" }],
      isLoading: false,
      isError: false,
    }
    rerender(
      <MemoryRouter>
        <StudentHome />
      </MemoryRouter>
    )
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load your courses" })).not.toBeInTheDocument()
  })
})
