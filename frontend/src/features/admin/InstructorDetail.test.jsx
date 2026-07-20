import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let assignedResult
const setCourses = { mutate: vi.fn(), isPending: false }
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
  useSetInstructorCourses: () => setCourses,
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
  assignedResult = { data: [{ course_id: "c1" }], isLoading: false }
  setCourses.mutate.mockClear()
  lower.mutate.mockClear()
  navigate.mockClear()
})

describe("InstructorDetail", () => {
  it("shows the instructor and seeds the assigned-course checklist", () => {
    render(<InstructorDetail />)
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument()
    const geog = screen.getByRole("checkbox", { name: /GEOG 250/ })
    const phys = screen.getByRole("checkbox", { name: /PHYS 100/ })
    expect(geog).toBeChecked() // c1 assigned
    expect(phys).not.toBeChecked()
  })

  it("saves the updated assignment set", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("checkbox", { name: /PHYS 100/ })) // add c2
    await userEvent.click(screen.getByRole("button", { name: "Save assignments" }))
    expect(setCourses.mutate).toHaveBeenCalled()
    const [ids] = setCourses.mutate.mock.calls[0]
    expect(ids).toEqual(expect.arrayContaining(["c1", "c2"]))
  })

  it("removes (demotes) the instructor after confirmation", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Remove instructor" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove instructor" }))
    await waitFor(() => expect(lower.mutate).toHaveBeenCalledWith("ada@x.com", expect.any(Object)))
  })
})
