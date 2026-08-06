import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let instructorsResult
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({
  useAdminInstructors: () => instructorsResult,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigate, useParams: () => ({}) }
})

import { InstructorList, instructorLabel } from "./InstructorList"

const INSTRUCTORS = [
  { user_email: "ada@x.com", first_name: "ada", last_name: "lovelace" },
  { user_email: "pending@x.com", first_name: null, last_name: null },
]

beforeEach(() => {
  instructorsResult = { data: INSTRUCTORS, isLoading: false }
  navigate.mockClear()
})

describe("instructorLabel", () => {
  it("uses 'Lastname, Firstname' when present, else the email", () => {
    expect(instructorLabel(INSTRUCTORS[0])).toBe("Lovelace, Ada")
    expect(instructorLabel(INSTRUCTORS[1])).toBe("pending@x.com")
  })
})

describe("InstructorList", () => {
  it("renders instructors and flags pending signups", () => {
    render(<InstructorList />)
    expect(screen.getByText("Lovelace, Ada")).toBeInTheDocument()
    expect(screen.getByText("Invited — awaiting signup")).toBeInTheDocument()
  })

  it("navigates to the (encoded) instructor detail on click", async () => {
    render(<InstructorList />)
    await userEvent.click(screen.getByText("Lovelace, Ada"))
    expect(navigate).toHaveBeenCalledWith("/admin/instructors/ada%40x.com")
  })

  it("filters by the debounced search", async () => {
    render(<InstructorList />)
    await userEvent.type(screen.getByRole("searchbox", { name: "Search instructors" }), "pending")
    await waitFor(() => expect(screen.queryByText("Lovelace, Ada")).not.toBeInTheDocument())
  })

  it("announces a labelled loading region while instructors load", () => {
    instructorsResult = { data: undefined, isLoading: true }
    render(<InstructorList />)
    expect(screen.getByRole("status", { name: /loading instructors/i })).toBeInTheDocument()
  })

  it("shows an accessible ErrorState with retry when instructors fail to load", async () => {
    const refetch = vi.fn()
    instructorsResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<InstructorList />)
    expect(screen.getByRole("heading", { name: "Couldn't load instructors" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → list)", async () => {
    const refetch = vi.fn()
    instructorsResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<InstructorList />)
    expect(screen.getByRole("heading", { name: "Couldn't load instructors" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    instructorsResult = { data: INSTRUCTORS, isLoading: false, isError: false }
    rerender(<InstructorList />)
    expect(screen.getByText("Lovelace, Ada")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load instructors" })).not.toBeInTheDocument()
  })
})
