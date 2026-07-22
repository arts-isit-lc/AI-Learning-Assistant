import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const create = { mutate: vi.fn(), isPending: false }
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({
  useAdminInstructors: () => ({ data: [{ user_email: "ada@x.com", first_name: "ada", last_name: "lovelace" }] }),
  useCreateCourse: () => create,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useNavigate: () => navigate,
    // The modal renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. Bare render — stub the blocker as never-blocking; the guard's own
    // behaviour is covered in UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CreateCourse, generateAccessCode, parseCourseCode } from "./CreateCourse"

beforeEach(() => {
  create.mutate.mockClear()
  navigate.mockClear()
})

describe("generateAccessCode", () => {
  it("produces a XXXX-XXXX-XXXX-XXXX code", () => {
    expect(generateAccessCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })
})

describe("parseCourseCode", () => {
  it("splits a 'DEPT NUMBER' code (last token = number)", () => {
    expect(parseCourseCode("GEOG 210")).toEqual({ department: "GEOG", number: "210" })
    expect(parseCourseCode("GEOG_V 412")).toEqual({ department: "GEOG_V", number: "412" })
    expect(parseCourseCode("GEOG")).toEqual({ department: "GEOG", number: "" })
  })
})

describe("CreateCourse", () => {
  it("disables Add course until code, title, and term are all provided", async () => {
    render(<CreateCourse />)
    expect(screen.getByRole("button", { name: "Add course" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Course code/), "GEOG 250")
    await userEvent.type(screen.getByLabelText(/Course title/), "Intro Geography")
    // Term is required too — the button stays disabled until a term is picked.
    expect(screen.getByRole("button", { name: "Add course" })).toBeDisabled()
    await userEvent.click(screen.getByRole("combobox", { name: "Term" }))
    await userEvent.click(await screen.findByRole("option", { name: "2026 Winter Term 2" }))
    expect(screen.getByRole("button", { name: "Add course" })).toBeEnabled()
  })

  it("regenerates the access code on demand", async () => {
    render(<CreateCourse />)
    const codeEl = screen.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    const before = codeEl.textContent
    // regenerate until it differs (astronomically unlikely to repeat, but guard the flake)
    await userEvent.click(screen.getByRole("button", { name: "Generate new code" }))
    await waitFor(() =>
      expect(screen.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/).textContent).not.toBe(
        before
      )
    )
  })

  it("creates the course (code parsed to dept+number) with the term, access code + instructors", async () => {
    render(<CreateCourse />)
    await userEvent.type(screen.getByLabelText(/Course code/), "GEOG 250")
    await userEvent.type(screen.getByLabelText(/Course title/), "Intro Geography")
    await userEvent.click(screen.getByRole("combobox", { name: "Term" }))
    await userEvent.click(await screen.findByRole("option", { name: "2026 Winter Term 2" }))
    // Instructors is a multi-select: open it, toggle Ada, then close the popover.
    await userEvent.click(screen.getByRole("button", { name: "Instructors" }))
    await userEvent.click(await screen.findByRole("button", { name: "Lovelace, Ada" }))
    await userEvent.click(screen.getByRole("button", { name: "Instructors" }))
    await userEvent.click(screen.getByRole("button", { name: "Add course" }))

    await waitFor(() => expect(create.mutate).toHaveBeenCalled())
    const [payload] = create.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      courseName: "Intro Geography",
      department: "GEOG",
      number: "250",
      term: "2026 Winter Term 2",
      active: true,
      instructorEmails: ["ada@x.com"],
    })
    expect(payload.accessCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })
})
