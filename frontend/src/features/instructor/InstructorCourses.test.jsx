import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"

let coursesResult
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({
  useInstructorCourses: () => coursesResult,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigate }
})

import { InstructorCourses } from "./InstructorCourses"

const COURSES = [
  { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro Geography" },
  { course_id: "c2", course_department: "phys", course_number: "100", course_name: "Mechanics" },
]

function renderCourses() {
  return render(
    <MemoryRouter>
      <InstructorCourses />
    </MemoryRouter>
  )
}

beforeEach(() => {
  coursesResult = { data: [], isLoading: false, isError: false }
  navigate.mockClear()
})

describe("InstructorCourses", () => {
  it("renders a card per course the instructor teaches", () => {
    coursesResult = { data: COURSES, isLoading: false, isError: false }
    renderCourses()
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("PHYS 100")).toBeInTheDocument()
  })

  it("navigates to the course workspace when a card is opened", async () => {
    coursesResult = { data: COURSES, isLoading: false, isError: false }
    renderCourses()
    await userEvent.click(screen.getByText("GEOG 250"))
    expect(navigate).toHaveBeenCalledWith("/instructor/courses/c1")
  })

  it("filters the grid by the debounced search query", async () => {
    coursesResult = { data: COURSES, isLoading: false, isError: false }
    renderCourses()
    await userEvent.type(screen.getByRole("searchbox", { name: "Search courses" }), "mechanics")
    await waitFor(() => expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument())
    expect(screen.getByText("PHYS 100")).toBeInTheDocument()
  })

  it("shows the empty state when the instructor has no courses", () => {
    renderCourses()
    expect(screen.getByRole("heading", { name: "No courses yet" })).toBeInTheDocument()
  })

  it("shows an error alert when the list fails to load", () => {
    coursesResult = { data: undefined, isLoading: false, isError: true }
    renderCourses()
    expect(screen.getByText("Couldn’t load your courses")).toBeInTheDocument()
  })
})
