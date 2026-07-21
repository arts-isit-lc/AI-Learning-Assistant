import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let assignedResult
const updateInstructorAccess = { mutate: vi.fn(), isPending: false }
const enroll = { mutate: vi.fn(), isPending: false }
const unenroll = { mutate: vi.fn(), isPending: false }
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
  updateInstructorAccess.mutate.mockClear()
  enroll.mutate.mockClear()
  unenroll.mutate.mockClear()
  lower.mutate.mockClear()
  navigate.mockClear()
})

describe("InstructorDetail", () => {
  it("shows the instructor and their assigned courses with access toggles", () => {
    render(<InstructorDetail />)
    expect(screen.getByRole("heading", { name: "Lovelace, Ada" })).toBeInTheDocument()
    // course code + name render on separate lines
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("Intro")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" })).toBeInTheDocument()
  })

  it("toggles a per-course OCELIA access flag (B4)", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" }))
    expect(updateInstructorAccess.mutate).toHaveBeenCalledWith(
      { courseId: "c1", instructorEmail: "ada@x.com", access: false },
      expect.any(Object)
    )
  })

  it("removes a course assignment after confirmation", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Remove course?")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove course" }))
    expect(unenroll.mutate).toHaveBeenCalledWith(
      { courseId: "c1", instructorEmail: "ada@x.com" },
      expect.any(Object)
    )
  })

  it("assigns an unassigned course from the picker", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /PHYS 100/ }))
    expect(enroll.mutate).toHaveBeenCalledWith(
      { courseId: "c2", instructorEmail: "ada@x.com" },
      expect.any(Object)
    )
  })

  it("deletes (demotes) the instructor after confirmation", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Delete instructor" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete instructor" }))
    await waitFor(() => expect(lower.mutate).toHaveBeenCalledWith("ada@x.com", expect.any(Object)))
  })
})
