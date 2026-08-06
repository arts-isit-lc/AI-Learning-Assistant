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
    // The pane renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. This is a bare render, so stub the blocker as never-blocking; the
    // guard's own behaviour is covered in UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})

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

  it("enables Undo with Save on a staged edit and resets everything on click", async () => {
    render(<InstructorDetail />)
    const undo = screen.getByRole("button", { name: "Undo" })
    const save = screen.getByRole("button", { name: "Save changes" })
    expect(undo).toBeDisabled()
    expect(save).toBeDisabled()

    // A staged course removal enables both (and drops the row).
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument()
    expect(undo).toBeEnabled()
    expect(save).toBeEnabled()

    // Undo reverts everything: the row returns, both disable again, nothing saved.
    await userEvent.click(undo)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(undo).toBeDisabled()
    expect(save).toBeDisabled()
    expect(unenroll.mutateAsync).not.toHaveBeenCalled()
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

  it("deletes (demotes) the instructor immediately after confirmation", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Delete instructor" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete instructor" }))
    await waitFor(() => expect(lower.mutate).toHaveBeenCalledWith("ada@x.com", expect.any(Object)))
  })

  it("gives the Delete instructor button no hover state change (no underline)", () => {
    render(<InstructorDetail />)
    const del = screen.getByRole("button", { name: "Delete instructor" })
    expect(del).toHaveClass("hover:no-underline")
    expect(del).not.toHaveClass("hover:underline")
  })

  it("styles Undo/Save: 28px tall, 4px radius + lavender hover; solid #808080 disabled, #6829C2 when dirty", async () => {
    render(<InstructorDetail />)
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
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" }))
    expect(screen.getByRole("button", { name: "Undo" })).toHaveClass("text-primary")
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("text-primary", "border-primary")
  })

  it("announces a labelled loading region while the assigned courses load", () => {
    assignedResult = { data: undefined, isLoading: true }
    render(<InstructorDetail />)
    expect(screen.getByRole("status", { name: /loading assigned courses/i })).toBeInTheDocument()
  })

  it("shows an ErrorState with retry when the assigned courses fail to load", async () => {
    const refetch = vi.fn()
    assignedResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<InstructorDetail />)
    expect(screen.getByRole("heading", { name: "Couldn't load assigned courses" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers the assigned courses after a successful retry", async () => {
    const refetch = vi.fn()
    assignedResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<InstructorDetail />)
    expect(screen.getByRole("heading", { name: "Couldn't load assigned courses" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    assignedResult = {
      data: [{ course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro", access_enabled: true }],
      isLoading: false,
      isError: false,
    }
    rerender(<InstructorDetail />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load assigned courses" })).not.toBeInTheDocument()
  })

  it("shows an inline error when a staged save partially fails", async () => {
    updateInstructorAccess.mutateAsync.mockRejectedValueOnce(new Error("boom"))
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't be saved/i)
  })

  it("assigns a course via the '+' picker (staged) and commits the enrolment on Save", async () => {
    render(<InstructorDetail />)
    // The picker only offers courses not already assigned (c1 is assigned).
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByText(/GEOG 250/)).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: /PHYS 100 — Mechanics/ }))

    // Staged: the picker closes, the row appears, nothing enrolled yet.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByText("PHYS 100")).toBeInTheDocument()
    expect(enroll.mutateAsync).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(enroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c2", instructorEmail: "ada@x.com" })
    )
  })

  it("tells the picker when every course is already assigned", async () => {
    assignedResult = {
      data: [
        { course_id: "c1", course_department: "geog", course_number: "250", course_name: "Intro", access_enabled: true },
        { course_id: "c2", course_department: "phys", course_number: "100", course_name: "Mechanics", access_enabled: true },
      ],
      isLoading: false,
    }
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/already assigned to every course/i)).toBeInTheDocument()
  })
})
