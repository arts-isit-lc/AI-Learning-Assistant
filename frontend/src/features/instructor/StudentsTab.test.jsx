import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let studentsResult
const deleteStudent = {
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue(undefined),
  isPending: false,
  isError: false,
  reset: vi.fn(),
}

vi.mock("@/services/queries", () => ({
  useStudents: () => studentsResult,
  useDeleteStudent: () => deleteStudent,
}))
vi.mock("./StudentDetail", () => ({ StudentDetail: () => <div>student detail</div> }))

let params
const setSearchParams = vi.fn()
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ courseId: "c1" }),
    useSearchParams: () => [params, setSearchParams],
    // StudentsTab renders <UnsavedChangesPrompt> (useBlocker needs a data router).
    // Stub it as never-blocking; the guard is covered in its own test.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})

import { StudentsTab } from "./StudentsTab"

const STUDENTS = [
  { first_name: "ada", last_name: "lovelace", user_email: "ada@x.com" },
  { first_name: "alan", last_name: "turing", user_email: "alan@x.com" },
]

beforeEach(() => {
  studentsResult = { data: STUDENTS, isLoading: false, isError: false }
  params = new URLSearchParams()
  setSearchParams.mockClear()
  deleteStudent.mutate.mockClear()
  deleteStudent.mutateAsync.mockClear().mockResolvedValue(undefined)
  deleteStudent.isError = false
})

describe("StudentsTab", () => {
  it("renders the roster (Student / Contact / Remove) with Lastname, Firstname", () => {
    render(<StudentsTab />)
    expect(screen.getByText("Student")).toBeInTheDocument()
    expect(screen.getByText("Contact")).toBeInTheDocument()
    expect(screen.getByText("Remove")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Lovelace, Ada" })).toBeInTheDocument()
    expect(screen.getByText("alan@x.com")).toBeInTheDocument()
  })

  it("opens the student's chat history via the ?student param when the name is clicked", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Lovelace, Ada" }))
    expect(setSearchParams).toHaveBeenCalled()
    const updater = setSearchParams.mock.calls[0][0]
    expect(updater(new URLSearchParams()).get("student")).toBe("ada@x.com")
  })

  it("renders the inline detail when a student is selected", () => {
    params = new URLSearchParams("student=ada@x.com")
    render(<StudentsTab />)
    expect(screen.getByText("student detail")).toBeInTheDocument()
  })

  it("styles the remove icon with the non-chevron state set: #6829C2 → #2E0666 hover → #000 pressed", () => {
    render(<StudentsTab />)
    const remove = screen.getByRole("button", { name: "Remove Lovelace, Ada" })
    expect(remove).toHaveClass("text-primary", "hover:text-primary-dark", "active:text-neutral-900")
    // Colour-only per the icon rule — no hover background fill.
    expect(remove).not.toHaveClass("hover:bg-primary-subtle")
  })

  it("keeps Undo + Save changes disabled until a removal is staged", () => {
    render(<StudentsTab />)
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("stages a removal — hiding the row and enabling Undo + Save — without persisting", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Lovelace, Ada" }))

    // The row drops out immediately; nothing is persisted; Undo + Save light up.
    expect(screen.queryByRole("button", { name: "Lovelace, Ada" })).not.toBeInTheDocument()
    expect(deleteStudent.mutateAsync).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })

  it("restores a staged removal on Undo (nothing persisted)", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Lovelace, Ada" }))
    expect(screen.queryByRole("button", { name: "Lovelace, Ada" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Undo" }))
    // Row back; nothing persisted; Undo + Save disabled again.
    expect(screen.getByRole("button", { name: "Lovelace, Ada" })).toBeInTheDocument()
    expect(deleteStudent.mutateAsync).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("publishes staged removals only after confirming the Save changes dialog", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Lovelace, Ada" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    // A confirmation dialog gates the publish — nothing persisted yet.
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Remove students?")).toBeInTheDocument()
    expect(deleteStudent.mutateAsync).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    expect(deleteStudent.mutateAsync).toHaveBeenCalledWith("ada@x.com")
  })

  it("does not persist when the Save changes confirmation is cancelled (removal stays staged)", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Lovelace, Ada" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    expect(deleteStudent.mutateAsync).not.toHaveBeenCalled()
    // Still staged so the user can retry: row hidden, Save still enabled.
    expect(screen.queryByRole("button", { name: "Lovelace, Ada" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })

  it("sorts by the Student column and toggles the direction (Contact sortable, Remove not)", async () => {
    render(<StudentsTab />)
    const lovelace = screen.getByRole("button", { name: "Lovelace, Ada" })
    const turing = screen.getByRole("button", { name: "Turing, Alan" })
    const following = Node.DOCUMENT_POSITION_FOLLOWING

    // Default sort: name ascending → Lovelace precedes Turing.
    expect(lovelace.compareDocumentPosition(turing) & following).toBeTruthy()

    // Clicking the Student header flips to descending → Turing precedes Lovelace.
    await userEvent.click(screen.getByRole("button", { name: "Student" }))
    expect(turing.compareDocumentPosition(lovelace) & following).toBeTruthy()

    // Student + Contact are sortable (header is a button); Remove is not.
    expect(screen.getByRole("button", { name: "Contact" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Remove" })).toBeInTheDocument()
  })

  it("paginates the roster at 20 rows/page with a result count", async () => {
    studentsResult = {
      data: Array.from({ length: 25 }, (_, i) => ({
        first_name: `student${i}`,
        last_name: String(i).padStart(2, "0"),
        user_email: `s${i}@x.com`,
      })),
      isLoading: false,
      isError: false,
    }
    render(<StudentsTab />)

    expect(screen.getByText("Displaying 20 out of 25 results")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Page 2" }))
    expect(screen.getByText("Displaying 5 out of 25 results")).toBeInTheDocument()
  })

  it("shows the empty state when no students are enrolled, styled like the Configuration placeholder (muted fill, no border)", () => {
    studentsResult = { data: [], isLoading: false, isError: false }
    render(<StudentsTab />)
    const heading = screen.getByRole("heading", { name: "No students enrolled yet" })
    expect(heading).toBeInTheDocument()
    expect(heading.closest("div")).toHaveClass("border-0", "bg-muted")
  })

  it("shows the block skeleton loader (no table chrome) while the roster loads", () => {
    studentsResult = { data: undefined, isLoading: true, isError: false }
    render(<StudentsTab />)
    expect(screen.getByRole("status", { name: /loading roster/i })).toBeInTheDocument()
    // The table (and its purple header) is replaced by the block skeleton…
    expect(screen.queryByRole("columnheader", { name: "Student" })).not.toBeInTheDocument()
    // …while the search field stays, matching the other list screens.
    expect(screen.getByRole("searchbox", { name: "Search students" })).toBeInTheDocument()
  })

  it("shows an accessible ErrorState with retry when the roster fails to load", async () => {
    const refetch = vi.fn()
    studentsResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<StudentsTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load the roster" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → roster)", async () => {
    const refetch = vi.fn()
    studentsResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<StudentsTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load the roster" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    studentsResult = { data: STUDENTS, isLoading: false, isError: false }
    rerender(<StudentsTab />)
    expect(screen.getByRole("button", { name: "Lovelace, Ada" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load the roster" })).not.toBeInTheDocument()
  })
})
