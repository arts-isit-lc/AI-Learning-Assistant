import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let instructorsAssigned
const setInstructors = { mutate: vi.fn(), isPending: false }
const updateAccess = { mutate: vi.fn(), isPending: false }
const del = { mutate: vi.fn(), isPending: false }
const navigate = vi.fn()

const COURSE = {
  course_id: "c1",
  course_department: "geog",
  course_number: "250",
  course_name: "Intro Geography",
  course_access_code: "ABCD-EFGH-IJKL-MNOP",
  course_student_access: true,
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
  useSetCourseInstructors: () => setInstructors,
  useUpdateCourseAccess: () => updateAccess,
  useDeleteCourse: () => del,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useParams: () => ({ courseId: "c1" }), useNavigate: () => navigate }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CourseDetail } from "./CourseDetail"

beforeEach(() => {
  instructorsAssigned = { data: [{ user_email: "ada@x.com", first_name: "ada", last_name: "lovelace" }], isLoading: false }
  setInstructors.mutate.mockClear()
  updateAccess.mutate.mockClear()
  del.mutate.mockClear()
  navigate.mockClear()
})

describe("CourseDetail", () => {
  it("renders the course, access code, and seeds the instructor checklist", () => {
    render(<CourseDetail />)
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    expect(screen.getByText("ABCD-EFGH-IJKL-MNOP")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: /Ada Lovelace/ })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /Alan Turing/ })).not.toBeChecked()
  })

  it("saves the updated instructor set", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("checkbox", { name: /Alan Turing/ }))
    await userEvent.click(screen.getByRole("button", { name: "Save instructors" }))
    const [emails] = setInstructors.mutate.mock.calls[0]
    expect(emails).toEqual(expect.arrayContaining(["ada@x.com", "alan@x.com"]))
  })

  it("persists an access toggle immediately", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("switch"))
    expect(updateAccess.mutate).toHaveBeenCalledWith(
      { courseId: "c1", access: false },
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
