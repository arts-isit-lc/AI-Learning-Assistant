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
  it("uses the full name when present, else the email", () => {
    expect(instructorLabel(INSTRUCTORS[0])).toBe("Ada Lovelace")
    expect(instructorLabel(INSTRUCTORS[1])).toBe("pending@x.com")
  })
})

describe("InstructorList", () => {
  it("renders instructors and flags pending signups", () => {
    render(<InstructorList />)
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByText("Invited — awaiting signup")).toBeInTheDocument()
  })

  it("navigates to the (encoded) instructor detail on click", async () => {
    render(<InstructorList />)
    await userEvent.click(screen.getByText("Ada Lovelace"))
    expect(navigate).toHaveBeenCalledWith("/admin/instructors/ada%40x.com")
  })

  it("filters by the debounced search", async () => {
    render(<InstructorList />)
    await userEvent.type(screen.getByRole("searchbox", { name: "Search instructors" }), "pending")
    await waitFor(() => expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument())
  })
})
