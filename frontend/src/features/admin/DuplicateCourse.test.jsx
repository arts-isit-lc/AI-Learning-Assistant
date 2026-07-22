import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const duplicate = { mutate: vi.fn(), isPending: false }
const navigate = vi.fn()

const courses = [
  {
    course_id: "src-1",
    course_name: "Intro Geography",
    course_department: "GEOG",
    course_number: "250",
    course_access_code: "AAAA-BBBB-CCCC-DDDD",
    course_student_access: true,
    system_prompt: "Base prompt",
    term: "2026 Winter Term 1",
  },
]

vi.mock("@/services/queries", () => ({
  useAdminCourses: () => ({ data: courses }),
  useDuplicateCourse: () => duplicate,
  // CreateCourse (imported for generateAccessCode/parseCourseCode) references
  // these at module scope; never called here (CreateCourse isn't rendered).
  useAdminInstructors: () => ({ data: [] }),
  useCreateCourse: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useNavigate: () => navigate,
    // The modal renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. Stub it as never-blocking; the guard's own behaviour is covered in
    // UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { DuplicateCourse } from "./DuplicateCourse"

beforeEach(() => {
  duplicate.mutate.mockClear()
  navigate.mockClear()
})

/** Open the source-course dropdown and pick "Intro Geography". */
async function pickSource() {
  await userEvent.click(screen.getByRole("combobox", { name: "Course to duplicate" }))
  await userEvent.click(await screen.findByRole("option", { name: /Intro Geography/ }))
}

describe("DuplicateCourse", () => {
  it("disables Duplicate until a source course is selected", async () => {
    render(<DuplicateCourse />)
    expect(screen.getByRole("button", { name: "Duplicate course" })).toBeDisabled()
    await pickSource()
    expect(screen.getByRole("button", { name: "Duplicate course" })).toBeEnabled()
  })

  it("prefills the code, title (with ' (copy)'), and term from the chosen source", async () => {
    render(<DuplicateCourse />)
    await pickSource()
    expect(screen.getByLabelText(/Course code/)).toHaveValue("GEOG 250")
    expect(screen.getByLabelText(/Course title/)).toHaveValue("Intro Geography (copy)")
    // The Term trigger reflects the source course's term.
    expect(screen.getByRole("combobox", { name: "Term" })).toHaveTextContent("2026 Winter Term 1")
  })

  it("regenerates the access code on demand", async () => {
    render(<DuplicateCourse />)
    const before = screen.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/).textContent
    await userEvent.click(screen.getByRole("button", { name: "Generate new code" }))
    await waitFor(() =>
      expect(
        screen.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/).textContent
      ).not.toBe(before)
    )
  })

  it("duplicates with the source id, edited fields, term + a fresh access code", async () => {
    render(<DuplicateCourse />)
    await pickSource()
    await userEvent.click(screen.getByRole("button", { name: "Duplicate course" }))

    await waitFor(() => expect(duplicate.mutate).toHaveBeenCalled())
    const [payload] = duplicate.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      sourceCourseId: "src-1",
      courseName: "Intro Geography (copy)",
      department: "GEOG",
      number: "250",
      term: "2026 Winter Term 1",
      active: true,
      systemPrompt: "Base prompt",
    })
    expect(payload.accessCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })
})
