import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let studentsResult
let accessCodeResult
const regenerate = { mutate: vi.fn(), isPending: false }
const deleteStudent = { mutate: vi.fn(), isPending: false }

vi.mock("@/services/queries", () => ({
  useStudents: () => studentsResult,
  useAccessCode: () => accessCodeResult,
  useRegenerateAccessCode: () => regenerate,
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
  accessCodeResult = { data: "GEOG-A1B2-C3D4" }
  params = new URLSearchParams()
  setSearchParams.mockClear()
  regenerate.mutate.mockClear()
  deleteStudent.mutate.mockClear()
})

describe("StudentsTab", () => {
  it("renders the roster and the course access code", () => {
    render(<StudentsTab />)
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByText("alan@x.com")).toBeInTheDocument()
    expect(screen.getByText("GEOG-A1B2-C3D4")).toBeInTheDocument()
  })

  it("opens the student's chat history via the ?student param", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getAllByRole("button", { name: "View chats" })[0])
    expect(setSearchParams).toHaveBeenCalled()
    const updater = setSearchParams.mock.calls[0][0]
    expect(updater(new URLSearchParams()).get("student")).toBe("ada@x.com")
  })

  it("renders the inline detail when a student is selected", () => {
    params = new URLSearchParams("student=ada@x.com")
    render(<StudentsTab />)
    expect(screen.getByText("student detail")).toBeInTheDocument()
  })

  it("unenrolls a student after confirmation", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getAllByRole("button", { name: "Unenroll" })[0])
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Unenroll" }))
    expect(deleteStudent.mutate).toHaveBeenCalledWith("ada@x.com", expect.any(Object))
  })

  it("regenerates the access code after confirmation", async () => {
    render(<StudentsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Regenerate" }))
    expect(regenerate.mutate).toHaveBeenCalled()
  })

  it("shows an empty message when no students are enrolled", () => {
    studentsResult = { data: [], isLoading: false, isError: false }
    render(<StudentsTab />)
    expect(screen.getByText("No students enrolled yet.")).toBeInTheDocument()
  })
})
