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
    refetch: vi.fn().mockResolvedValue({}),
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

  it("waits for the assigned-courses refetch before clearing staged edits, so the toggle doesn't flip back", async () => {
    // Deferred refetch: mirrors the real background refetch the mutation
    // invalidations trigger. Save must await this before discarding the staged
    // edit, otherwise the toggle briefly renders the stale server value
    // (a visible on→off→on flip).
    let resolveRefetch
    assignedResult.refetch = vi.fn(() => new Promise((resolve) => { resolveRefetch = resolve }))
    render(<InstructorDetail />)

    const switchName = "OCELIA access for GEOG 250 — Intro"
    // Stage access OFF (server value is ON).
    await userEvent.click(screen.getByRole("switch", { name: switchName }))
    expect(screen.getByRole("switch", { name: switchName })).toHaveAttribute("aria-checked", "false")

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    // The access mutation committed and the refetch was requested…
    await waitFor(() => expect(updateInstructorAccess.mutateAsync).toHaveBeenCalled())
    await waitFor(() => expect(assignedResult.refetch).toHaveBeenCalled())

    // …but while it's still in flight the staged (OFF) value holds — no revert
    // to the stale server (ON) value.
    expect(screen.getByRole("switch", { name: switchName })).toHaveAttribute("aria-checked", "false")

    // Let the refetch land; the save settles cleanly.
    resolveRefetch({})
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled())
  })

  it("stages a course removal immediately (no dialog), then confirms it on Save before committing", async () => {
    render(<InstructorDetail />)
    // Staging the removal opens no dialog and drops the row right away.
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument()

    // Save changes now asks to confirm before the unenrolment runs.
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Remove course?")).toBeInTheDocument()
    // Body follows the mockup: names the instructor, the course, and the caveat.
    expect(within(dialog).getByText(/Lovelace, Ada/)).toBeInTheDocument()
    expect(within(dialog).getByText(/GEOG 250/)).toBeInTheDocument()
    expect(within(dialog).getByText(/need to add\s+them again/i)).toBeInTheDocument()
    expect(unenroll.mutateAsync).not.toHaveBeenCalled()

    // "Remove course" commits the unenrolment.
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove course" }))
    await waitFor(() =>
      expect(unenroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c1", instructorEmail: "ada@x.com" })
    )
  })

  it("Cancel on the remove confirmation aborts the save but keeps the removal staged; Undo restores", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Remove" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")

    // Cancel just closes the confirmation — nothing is unenrolled…
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(unenroll.mutateAsync).not.toHaveBeenCalled()
    // …and the removal is still staged (row absent, Save still active).
    expect(screen.queryByText("GEOG 250")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()

    // Undo is what actually adds the course back.
    await userEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(unenroll.mutateAsync).not.toHaveBeenCalled()
  })

  it("saves directly (no remove confirmation) when no course is staged for removal", async () => {
    render(<InstructorDetail />)
    // A non-removal edit (access toggle) saves straight through.
    await userEvent.click(screen.getByRole("switch", { name: "OCELIA access for GEOG 250 — Intro" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(updateInstructorAccess.mutateAsync).toHaveBeenCalledWith({
        courseId: "c1",
        instructorEmail: "ada@x.com",
        access: false,
      })
    )
    expect(screen.queryByText("Remove course?")).not.toBeInTheDocument()
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
      // Once active the ghost-primary interaction applies: hover darkens the text
      // to #2E0666 (primary-dark) and the press paints the #AA78F0 (primary-active)
      // surface with #2E0666 text. (These only fire while enabled — a disabled
      // button is pointer-events-none.)
      expect(btn).toHaveClass("hover:text-primary-dark", "active:bg-primary-active", "active:text-primary-dark")
      expect(btn).not.toHaveClass("bg-primary")
      // Inactive (disabled) is #BFBFBF (neutral-400) text on a white (#FFF /
      // bg-background) fill, at full opacity (base fade defeated).
      expect(btn).toHaveClass("bg-background", "text-neutral-400", "disabled:opacity-100")
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

  it("assigns a course via the '+' picker multiselect (staged) and commits the enrolment on Save", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog = await screen.findByRole("dialog")
    // Open the multiselect and tick PHYS 100 (GEOG 250 is already assigned, so
    // the pool never offers it).
    await userEvent.click(within(dialog).getByRole("button", { name: "Courses to assign" }))
    expect(within(dialog).queryByRole("checkbox", { name: /GEOG 250/ })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /PHYS 100 — Mechanics/ }))
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

    // Assign stages the pick and closes the picker; the row appears, nothing
    // enrolled yet.
    await userEvent.click(within(dialog).getByRole("button", { name: "Assign" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByText("PHYS 100")).toBeInTheDocument()
    expect(enroll.mutateAsync).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() =>
      expect(enroll.mutateAsync).toHaveBeenCalledWith({ courseId: "c2", instructorEmail: "ada@x.com" })
    )
  })

  it("keeps Assign disabled until a selection is applied, and Cancel closes without staging", async () => {
    render(<InstructorDetail />)
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog = await screen.findByRole("dialog")
    // Nothing picked yet → Assign is inactive.
    expect(within(dialog).getByRole("button", { name: "Assign" })).toBeDisabled()

    // Cancel discards the (empty) selection and closes; nothing staged.
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.queryByText("PHYS 100")).not.toBeInTheDocument()

    // Re-open, pick + apply → Assign activates.
    await userEvent.click(screen.getByRole("button", { name: "Assign course" }))
    const dialog2 = await screen.findByRole("dialog")
    await userEvent.click(within(dialog2).getByRole("button", { name: "Courses to assign" }))
    await userEvent.click(within(dialog2).getByRole("checkbox", { name: /PHYS 100 — Mechanics/ }))
    await userEvent.click(within(dialog2).getByRole("button", { name: "Apply" }))
    expect(within(dialog2).getByRole("button", { name: "Assign" })).toBeEnabled()
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
