import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let studentsResult
const deleteStudent = { mutate: vi.fn(), isPending: false }

vi.mock("@/services/queries", () => ({
  useStudents: () => studentsResult,
  useDeleteStudent: () => deleteStudent,
}))
vi.mock("./StudentDetail", () => ({ StudentDetail: () => <div>student detail</div> }))

let params
const setSearchParams = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ courseId: "c1" }),
    useSearchParams: () => [params, setSearchParams],
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

  it("removes (unenrolls) a student after confirmation", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Lovelace, Ada" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Delete student?")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete student" }))
    expect(deleteStudent.mutate).toHaveBeenCalledWith("ada@x.com", expect.any(Object))
  })

  it("shows the empty state when no students are enrolled", () => {
    studentsResult = { data: [], isLoading: false, isError: false }
    render(<StudentsTab />)
    expect(screen.getByRole("heading", { name: "No students enrolled yet" })).toBeInTheDocument()
  })
})
