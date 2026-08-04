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
    section: "001",
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
  it("hovers the Duplicate course button to #2E0666 (primary-dark)", () => {
    render(<DuplicateCourse />)
    expect(screen.getByRole("button", { name: "Duplicate course" })).toHaveClass("hover:bg-primary-dark")
  })

  it("disables Duplicate until a source course is selected", async () => {
    render(<DuplicateCourse />)
    expect(screen.getByRole("button", { name: "Duplicate course" })).toBeDisabled()
    await pickSource()
    expect(screen.getByRole("button", { name: "Duplicate course" })).toBeEnabled()
  })

  it("hides the editable fields until a source course is chosen, then reveals them", async () => {
    render(<DuplicateCourse />)
    // Initial state: only the source dropdown — no course code/title/term/section/access code yet.
    expect(screen.getByRole("combobox", { name: "Course to duplicate" })).toBeInTheDocument()
    expect(screen.queryByLabelText(/Course code/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Course title/)).not.toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Term" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Section")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Generate new code" })).not.toBeInTheDocument()

    await pickSource()

    // After selecting a source the fields appear (prefilled — see the prefill test).
    expect(screen.getByLabelText(/Course code/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Course title/)).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Term" })).toBeInTheDocument()
    expect(screen.getByLabelText("Section")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Generate new code" })).toBeInTheDocument()
  })

  it("prefills the code, title (with ' (copy)'), and term from the chosen source", async () => {
    render(<DuplicateCourse />)
    await pickSource()
    expect(screen.getByLabelText(/Course code/)).toHaveValue("GEOG 250")
    expect(screen.getByLabelText(/Course title/)).toHaveValue("Intro Geography (copy)")
    // The Term trigger reflects the source course's term.
    expect(screen.getByRole("combobox", { name: "Term" })).toHaveTextContent("2026 Winter Term 1")
    // The Section field reflects the source course's section.
    expect(screen.getByLabelText("Section")).toHaveValue("001")
  })

  it("regenerates the access code on demand", async () => {
    render(<DuplicateCourse />)
    // The access code lives in the disclosed section, so select a source first.
    await pickSource()
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
      section: "001",
      active: true,
      systemPrompt: "Base prompt",
    })
    expect(payload.accessCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })

  it("shows an inline error when duplication fails, keeping the form", async () => {
    duplicate.isError = true
    duplicate.error = { status: 500 }
    render(<DuplicateCourse />)
    await pickSource()
    expect(screen.getByRole("alert")).toHaveTextContent(/on our end/i)
    expect(screen.getByLabelText(/Course title/)).toHaveValue("Intro Geography (copy)")
    duplicate.isError = false
    duplicate.error = null
  })

  it("shows the identity-conflict message on a 409", async () => {
    duplicate.isError = true
    duplicate.error = { status: 409 }
    render(<DuplicateCourse />)
    await pickSource()
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i)
    duplicate.isError = false
    duplicate.error = null
  })
})
