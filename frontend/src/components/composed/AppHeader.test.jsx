import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AppHeader } from "./AppHeader"

vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    signOut: vi.fn(),
    isInstructorAsStudent: false,
    setIsInstructorAsStudent: vi.fn(),
  }),
}))

function renderHeader(role) {
  return render(
    <MemoryRouter>
      <AppHeader role={role} />
    </MemoryRouter>
  )
}

describe("AppHeader", () => {
  it("shows the OCELIA brand and sign out for every role", () => {
    renderHeader("student")
    expect(screen.getByText("OCELIA")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument()
  })

  it("renders the UBC crest in the brand lockup, linking home", () => {
    renderHeader("student")
    const logo = screen.getByRole("img", { name: /university of british columbia/i })
    expect(logo).toBeInTheDocument()
    // brand lockup (crest + wordmark) is the home link
    expect(logo.closest("a")).toHaveAttribute("href", "/")
  })

  it("renders instructor top-nav items including the global stubs + as-student toggle", () => {
    renderHeader("instructor")
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Global Analytics" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Global Chats" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /view as student/i })).toBeInTheDocument()
  })

  it("renders admin nav items", () => {
    renderHeader("admin")
    expect(screen.getByRole("link", { name: "Instructors" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
  })

  it("renders no primary nav for a student (breadcrumb-driven)", () => {
    renderHeader("student")
    expect(screen.queryByRole("link", { name: "Courses" })).toBeNull()
  })
})
