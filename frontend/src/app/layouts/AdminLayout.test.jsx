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

describe("AdminLayout", () => {
  it("renders the Instructors + Courses nav below the banner (not in the banner)", () => {
    render(
      <MemoryRouter initialEntries={["/admin/instructors"]}>
        <AdminLayout />
      </MemoryRouter>
    )
    expect(screen.getByRole("link", { name: "Instructors" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
    // banner brand still present
    expect(screen.getByText("OCELIA")).toBeInTheDocument()
  })
})
