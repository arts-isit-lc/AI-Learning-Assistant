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
  return { ...actual, useNavigate: () => navigate }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CreateCourse, generateAccessCode } from "./CreateCourse"

beforeEach(() => {
  create.mutate.mockClear()
  navigate.mockClear()
})

describe("generateAccessCode", () => {
  it("produces a XXXX-XXXX-XXXX-XXXX code", () => {
    expect(generateAccessCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })
})

describe("CreateCourse", () => {
  it("disables Create until the required fields are filled", async () => {
    render(<CreateCourse />)
    expect(screen.getByRole("button", { name: "Create course" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Course name"), "Intro Geography")
    await userEvent.type(screen.getByLabelText("Department"), "GEOG")
    await userEvent.type(screen.getByLabelText("Course number"), "250")
    expect(screen.getByRole("button", { name: "Create course" })).toBeEnabled()
  })

  it("only accepts digits in the course number", async () => {
    render(<CreateCourse />)
    const number = screen.getByLabelText("Course number")
    await userEvent.type(number, "2a5b0")
    expect(number).toHaveValue("250")
  })

  it("creates the course with a generated access code + selected instructors", async () => {
    render(<CreateCourse />)
    await userEvent.type(screen.getByLabelText("Course name"), "Intro Geography")
    await userEvent.type(screen.getByLabelText("Department"), "GEOG")
    await userEvent.type(screen.getByLabelText("Course number"), "250")
    await userEvent.click(screen.getByRole("checkbox", { name: /Ada Lovelace/ }))
    await userEvent.click(screen.getByRole("button", { name: "Create course" }))

    await waitFor(() => expect(create.mutate).toHaveBeenCalled())
    const [payload] = create.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      courseName: "Intro Geography",
      department: "GEOG",
      number: "250",
      active: true,
      instructorEmails: ["ada@x.com"],
    })
    expect(payload.accessCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  })
})
