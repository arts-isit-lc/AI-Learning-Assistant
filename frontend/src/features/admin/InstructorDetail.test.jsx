import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let assignedResult
const updateInstructorAccess = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
const enroll = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
const unenroll = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }
const lower = { mutate: vi.fn(), isPending: false }
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({
  useAdminInstructors: () => ({ data: [{ user_email: "ada@x.com", first_name: "ada", last_name: "lovelace" }] }),
  useAdminCourses: () => ({
    data: [
      { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro" },
      { course_id: "c2", course_department: "phys", course_number: "100", course_name: "Mechanics" },
    ],
  }),
  useInstructorAssignedCourses: () => assignedResult,
  useUpdateInstructorAccess: () => updateInstructorAccess,
  useEnrollInstructor: () => enroll,
  useUnenrollInstructor: () => unenroll,
  useLowerInstructor: () => lower,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ instructorId: encodeURIComponent("ada@x.com") }),
    useNavigate: () => navigate,
  }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { InstructorDetail } from "./InstructorDetail"

beforeEach(() => {
  assignedResult = {
    data: [
      { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro", access_enabled: true },
    ],
    isLoading: false,
  }
  updateInstructorAccess.mutateAsync.mockClear().mockResolvedValue({})
  enroll.mutateAsync.mockClear().mockResolvedValue({})
  unenroll.mutateAsync.mockClear().mockResolvedValue({})
  lower.mutate.mockClear()
  navigate.mockClear()
})

describe("InstructorDetail (staged editing)", () => {
  it("shows the instructor and their assigned courses with access toggles", () => {
    render(<InstructorDetail />)
    expect(screen.getByRole("heading", { name: "Lovelace, Ada" })).toBeInTheDocument()
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("Intro")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" })).toBeInTheDocument()
  })

  it("keeps Save changes disabled until there is a staged edit", async () => {
    render(<InstructorDetail />)
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" }))
    expect(save).toBeEnabled()
  })

  it("stages a per-course access toggle and commits it only on Save (B4)", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" }))
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

  it("stages a course removal (no confirm dialog) and commits it on Save", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    // Staged only: no confirm dialog, and the row disappears immediately.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument()
    expect(unenroll.mutateAsync).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(unenroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c1", instructorEmail: "ada@x.com" })
    )
  })

  it("stages a course assignment from the picker and commits it on Save", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /PHYS 100/ }))
    expect(enroll.mutateAsync).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(enroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c2", instructorEmail: "ada@x.com" })
    )
  })

  it("deletes (demotes) the instructor immediately after confirmation", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Delete instructor" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete instructor" }))
    await waitFor(() => expect(lower.mutate).toHaveBeenCalledWith("ada@x.com", expect.any(Object)))
  })
})
