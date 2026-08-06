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

  it("gives inactive nav tabs the instructor rounded brand hover (bg #F2E8FF / text #2E0666)", () => {
    render(
      <MemoryRouter initialEntries={["/admin/instructors"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    // Instructors is active here, so the hover applies to Courses.
    const courses = screen.getByRole("link", { name: "Courses" })
    expect(courses).toHaveClass("rounded")
    expect(courses).toHaveClass("hover:bg-primary-subtle")
    expect(courses).toHaveClass("hover:text-primary-dark")
    // Press (active): #AA78F0 (primary-active) surface + #2E0666 (primary-dark) text.
    expect(courses).toHaveClass("active:bg-primary-active", "active:text-primary-dark")
    // The old faded-purple text hover is gone.
    expect(courses).not.toHaveClass("hover:text-primary/80")
  })

  it("gives the active nav tab a 3px #6829C2 underline, #000 text, and no fill/hover/press", () => {
    render(
      <MemoryRouter initialEntries={["/admin/instructors"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    const active = screen.getByRole("link", { name: "Instructors" })
    expect(active).toHaveClass("border-b-[3px]", "border-primary", "text-neutral-900")
    expect(active).not.toHaveClass("rounded")
    expect(active).not.toHaveClass("hover:bg-primary-subtle")
    expect(active).not.toHaveClass("active:bg-primary-active")
  })

  it("shows the Add instructor action on the instructors section", () => {
    render(
      <MemoryRouter initialEntries={["/admin/instructors"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    expect(screen.getByRole("button", { name: "Add instructor" })).toBeInTheDocument()
  })

  it("shows the Duplicate course + Add course actions on the courses section", () => {
    render(
      <MemoryRouter initialEntries={["/admin/courses"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    expect(screen.getByRole("link", { name: "Duplicate course" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Add course" })).toBeInTheDocument()
  })
})
