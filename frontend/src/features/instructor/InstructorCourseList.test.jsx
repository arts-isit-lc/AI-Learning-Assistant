import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let coursesResult
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({ useInstructorCourses: () => coursesResult }))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigate, useParams: () => ({}) }
})

import { InstructorCourseList, courseCode } from "./InstructorCourseList"

const COURSES = [
  { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro Geography", course_student_access: true },
  { course_id: "c2", course_department: "phys", course_number: "100", course_name: "Mechanics", course_student_access: false },
]

beforeEach(() => {
  coursesResult = { data: COURSES, isLoading: false }
  navigate.mockClear()
})

describe("courseCode", () => {
  it("uppercases department + number", () => {
    expect(courseCode(COURSES[0])).toBe("GEOG 250")
  })
})

describe("InstructorCourseList", () => {
  it("renders courses with their active/inactive status", () => {
    render(<InstructorCourseList />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("PHYS 100")).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByText("Inactive")).toBeInTheDocument()
  })

  it("navigates to the course workspace on click", async () => {
    render(<InstructorCourseList />)
    await userEvent.click(screen.getByText("GEOG 250"))
    expect(navigate).toHaveBeenCalledWith("/instructor/courses/c1")
  })

  it("filters by the debounced search", async () => {
    render(<InstructorCourseList />)
    await userEvent.type(screen.getByRole("searchbox", { name: "Search courses" }), "mechanics")
    await waitFor(() => expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument())
  })
})
