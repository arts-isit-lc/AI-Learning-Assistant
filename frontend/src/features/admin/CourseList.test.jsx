import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let coursesResult
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({ useAdminCourses: () => coursesResult }))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigate, useParams: () => ({}) }
})

import { CourseList, courseCode } from "./CourseList"

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

describe("CourseList", () => {
  it("renders courses and marks inactive ones", () => {
    render(<CourseList />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("PHYS 100")).toBeInTheDocument()
    expect(screen.getByText("Inactive")).toBeInTheDocument() // c2 inactive
  })

  it("navigates to a course detail on click", async () => {
    render(<CourseList />)
    await userEvent.click(screen.getByText("GEOG 250"))
    expect(navigate).toHaveBeenCalledWith("/admin/courses/c1")
  })

  it("filters by the debounced search", async () => {
    render(<CourseList />)
    await userEvent.type(screen.getByRole("searchbox", { name: "Search courses" }), "mechanics")
    await waitFor(() => expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument())
  })

  it("shows an accessible ErrorState with retry when courses fail to load", async () => {
    const refetch = vi.fn()
    coursesResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<CourseList />)
    expect(screen.getByRole("heading", { name: "Couldn't load courses" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → list)", async () => {
    const refetch = vi.fn()
    coursesResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<CourseList />)
    expect(screen.getByRole("heading", { name: "Couldn't load courses" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    coursesResult = { data: COURSES, isLoading: false, isError: false }
    rerender(<CourseList />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load courses" })).not.toBeInTheDocument()
  })
})
