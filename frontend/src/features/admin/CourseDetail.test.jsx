import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let instructorsAssigned
const updateCourseAccess = { mutate: vi.fn(), isPending: false }
const updateInstructorAccess = { mutate: vi.fn(), isPending: false }
const enroll = { mutate: vi.fn(), isPending: false }
const unenroll = { mutate: vi.fn(), isPending: false }
const del = { mutate: vi.fn(), isPending: false }
const duplicate = { mutate: vi.fn(), isPending: false }
const navigate = vi.fn()

const COURSE = {
  course_id: "c1",
  course_department: "geog",
  course_number: "250",
  course_name: "Intro Geography",
  course_access_code: "ABCD-EFGH-IJKL-MNOP",
  course_student_access: true,
  system_prompt: "You are a tutor.",
}

vi.mock("@/services/queries", () => ({
  useAdminCourses: () => ({ data: [COURSE] }),
  useCourseInstructors: () => instructorsAssigned,
  useAdminInstructors: () => ({
    data: [
      { user_email: "ada@x.com", first_name: "ada", last_name: "lovelace" },
      { user_email: "alan@x.com", first_name: "alan", last_name: "turing" },
    ],
  }),
  useUpdateCourseAccess: () => updateCourseAccess,
  useUpdateInstructorAccess: () => updateInstructorAccess,
  useEnrollInstructor: () => enroll,
  useUnenrollInstructor: () => unenroll,
  useDeleteCourse: () => del,
  useDuplicateCourse: () => duplicate,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useParams: () => ({ courseId: "c1" }), useNavigate: () => navigate }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CourseDetail } from "./CourseDetail"

beforeEach(() => {
  instructorsAssigned = {
    data: [{ user_email: "ada@x.com", first_name: "ada", last_name: "lovelace", access_enabled: true }],
    isLoading: false,
  }
  updateCourseAccess.mutate.mockClear()
  updateInstructorAccess.mutate.mockClear()
  enroll.mutate.mockClear()
  unenroll.mutate.mockClear()
  del.mutate.mockClear()
  duplicate.mutate.mockClear()
  navigate.mockClear()
})

describe("CourseDetail", () => {
  it("renders the course header, access code, and assigned instructors", () => {
    render(<CourseDetail />)
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    expect(screen.getByText("ABCD-EFGH-IJKL-MNOP")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Course student access" })).toBeInTheDocument()
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "OCELIA access for Ada Lovelace" })).toBeInTheDocument()
  })

  it("persists the course active toggle immediately", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "Course student access" }))
    expect(updateCourseAccess.mutate).toHaveBeenCalledWith(
      { courseId: "c1", access: false },
      expect.any(Object)
    )
  })

  it("toggles a per-instructor OCELIA access flag (B4)", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for Ada Lovelace" }))
    expect(updateInstructorAccess.mutate).toHaveBeenCalledWith(
      { courseId: "c1", instructorEmail: "ada@x.com", access: false },
      expect.any(Object)
    )
  })

  it("removes an instructor from the course", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(unenroll.mutate).toHaveBeenCalledWith(
      { courseId: "c1", instructorEmail: "ada@x.com" },
      expect.any(Object)
    )
  })

  it("adds an unassigned instructor from the picker", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /Alan Turing/ }))
    expect(enroll.mutate).toHaveBeenCalledWith(
      { courseId: "c1", instructorEmail: "alan@x.com" },
      expect.any(Object)
    )
  })

  it("deletes the course after confirmation", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Delete course" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(del.mutate).toHaveBeenCalledWith("c1", expect.any(Object)))
  })
})
