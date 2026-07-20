import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import AdminLayout from "./AdminLayout"

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: { email: "admin@ubc.ca" },
    signOut: vi.fn(),
    isInstructorAsStudent: false,
    setIsInstructorAsStudent: vi.fn(),
  }),
}))

// AdminLayout renders AddInstructorDialog (which uses this hook) on the
// instructors section.
vi.mock("@/services/queries", () => ({
  useElevateInstructor: () => ({ mutate: vi.fn(), isPending: false }),
}))

describe("AdminLayout", () => {
  it("renders the ADMINISTRATION header + Instructors/Courses tabs below the banner", () => {
    render(
      <MemoryRouter initialEntries={["/admin/instructors"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    expect(screen.getByRole("heading", { name: /administration/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Instructors" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
    // banner brand still present
    expect(screen.getByText("OCELIA")).toBeInTheDocument()
  })

  it("shows the Add instructor action on the instructors section", () => {
    render(
      <MemoryRouter initialEntries={["/admin/instructors"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    expect(screen.getByRole("button", { name: "Add instructor" })).toBeInTheDocument()
  })

  it("shows the Add course action on the courses section", () => {
    render(
      <MemoryRouter initialEntries={["/admin/courses"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    expect(screen.getByRole("link", { name: "Add course" })).toBeInTheDocument()
  })
})
