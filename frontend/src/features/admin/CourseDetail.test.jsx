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
    expect(screen.getByText(/ABCD-EFGH-IJKL-MNOP/)).toBeInTheDocument()
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

  it("enables Undo with Save on a staged edit and resets everything on click", async () => {
    render(<CourseDetail />)
    const undo = screen.getByRole("button", { name: "Undo" })
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(undo).toBeDisabled()
    expect(save).toBeDisabled()

    // A staged instructor removal enables both (and drops the row).
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(screen.queryByText("Lovelace, Ada")).not.toBeInTheDocument()
    expect(undo).toBeEnabled()
    expect(save).toBeEnabled()

    // Undo reverts everything: the row returns, both disable again, nothing saved.
    await userEvent.click(undo)
    expect(screen.getByText("Lovelace, Ada")).toBeInTheDocument()
    expect(undo).toBeDisabled()
    expect(save).toBeDisabled()
    expect(unenroll.mutateAsync).not.toHaveBeenCalled()
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

  it("deletes the course immediately after confirmation", async () => {
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Delete course" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete course" }))
    await waitFor(() => expect(del.mutate).toHaveBeenCalledWith("c1", expect.any(Object)))
  })

  it("gives the Delete course button no hover state change (no underline)", () => {
    render(<CourseDetail />)
    const del = screen.getByRole("button", { name: "Delete course" })
    expect(del).toHaveClass("hover:no-underline")
    expect(del).not.toHaveClass("hover:underline")
  })

  it("styles Undo/Save: 28px tall, 4px radius + lavender hover; solid #808080 disabled, #6829C2 when dirty", async () => {
    render(<CourseDetail />)
    const undo = screen.getByRole("button", { name: "Undo" })
    const save = screen.getByRole("button", { name: "Save changes" })
    for (const btn of [undo, save]) {
      // 28px tall (h-7), rounded (4px), lavender (#F2E8FF) hover; not a solid CTA.
      expect(btn).toHaveClass("h-7", "rounded", "hover:bg-primary-subtle")
      expect(btn).not.toHaveClass("bg-primary")
      // Disabled text is a solid #808080 = neutral-300 at full opacity (base fade defeated).
      expect(btn).toHaveClass("text-neutral-300", "disabled:opacity-100")
    }
    // Save carries a transparent border while disabled; Undo has none.
    expect(undo).not.toHaveClass("border")
    expect(save).toHaveClass("border", "border-transparent")
    // A staged edit turns text #6829C2 and gives Save a #6829C2 border.
    await userEvent.click(screen.getByRole("switch", { name: "Course student access" }))
    expect(screen.getByRole("button", { name: "Undo" })).toHaveClass("text-primary")
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("text-primary", "border-primary")
  })

  it("shows an ErrorState with retry when the instructor list fails to load", async () => {
    const refetch = vi.fn()
    instructorsAssigned = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<CourseDetail />)
    expect(screen.getByRole("heading", { name: "Couldn't load instructors" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers the instructor list after a successful retry", async () => {
    const refetch = vi.fn()
    instructorsAssigned = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<CourseDetail />)
    expect(screen.getByRole("heading", { name: "Couldn't load instructors" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    instructorsAssigned = {
      data: [{ user_email: "ada@x.com", first_name: "ada", last_name: "lovelace", access_enabled: true }],
      isLoading: false,
      isError: false,
    }
    rerender(<CourseDetail />)
    expect(screen.getByText("Lovelace, Ada")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load instructors" })).not.toBeInTheDocument()
  })

  it("shows an inline error when a staged save partially fails", async () => {
    updateCourseAccess.mutateAsync.mockRejectedValueOnce(new Error("boom"))
    render(<CourseDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "Course student access" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be saved/i)
  })
})
