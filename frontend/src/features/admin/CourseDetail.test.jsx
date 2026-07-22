import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let instructorsAssigned
const updateCourseAccess = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
const updateInstructorAccess = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
const enroll = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
const unenroll = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
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
  return {
    ...actual,
    useParams: () => ({ courseId: "c1" }),
    useNavigate: () => navigate,
    // The pane renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. Bare render — stub the blocker as never-blocking; the guard's own
    // behaviour is covered in UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CourseDetail } from "./CourseDetail"

beforeEach(() => {
  instructorsAssigned = {
    data: [{ user_email: "ada@x.com", first_name: "ada", last_name: "lovelace", access_enabled: true }],
    isLoading: false,
  }
  updateCourseAccess.mutateAsync.mockClear().mockResolvedValue({})
  updateInstructorAccess.mutateAsync.mockClear().mockResolvedValue({})
  enroll.mutateAsync.mockClear().mockResolvedValue({})
  unenroll.mutateAsync.mockClear().mockResolvedValue({})
  del.mutate.mockClear()
  duplicate.mutate.mockClear()
  navigate.mockClear()
})

describe("CourseDetail (staged editing)", () => {
  it("renders the course header, access code, and assigned instructors", () => {
    render(<CourseDetail />)
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    expect(screen.getByText("ABCD-EFGH-IJKL-MNOP")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Course student access" })).toBeInTheDocument()
    expect(screen.getByText("Lovelace, Ada")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "OCELIA access for Lovelace, Ada" })).toBeInTheDocument()
  })

  it("keeps Save changes disabled until there is a staged edit", async () => {
    render(<CourseDetail />)
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "Course student access" }))
    expect(save).toBeEnabled()
  })

  it("stages the course active toggle and commits it on Save", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "Course student access" }))
    expect(updateCourseAccess.mutateAsync).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(updateCourseAccess.mutateAsync).toHaveBeenCalledWith({ courseId: "c1", access: false })
    )
  })

  it("stages a per-instructor access toggle and commits it on Save (B4)", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for Lovelace, Ada" }))
    expect(updateInstructorAccess.mutateAsync).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(updateInstructorAccess.mutateAsync).toHaveBeenCalledWith({
        courseId: "c1",
        instructorEmail: "ada@x.com",
        access: false,
      })
    )
  })

  it("stages an instructor removal (no confirm dialog) and commits it on Save", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("Lovelace, Ada")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(unenroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c1", instructorEmail: "ada@x.com" })
    )
  })

  it("stages an instructor addition from the picker and commits it on Save", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Add instructor" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /Turing, Alan/ }))
    expect(enroll.mutateAsync).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(enroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c1", instructorEmail: "alan@x.com" })
    )
  })

  it("deletes the course immediately after confirmation", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Delete course" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete course" }))
    await waitFor(() => expect(del.mutate).toHaveBeenCalledWith("c1", expect.any(Object)))
  })
})
