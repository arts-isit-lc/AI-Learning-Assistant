import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { AppHeader } from "./AppHeader"

const { signOut, setAsStudent } = vi.hoisted(() => ({
  signOut: vi.fn(),
  setAsStudent: vi.fn(),
}))

let authState
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => authState,
}))

function renderHeader(role) {
  return render(
    <MemoryRouter>
      <AppHeader userRole={role} />
    </MemoryRouter>
  )
}

beforeEach(() => {
  authState = {
    user: { email: "instructor@ubc.ca" },
    signOut,
    isInstructorAsStudent: false,
    setIsInstructorAsStudent: setAsStudent,
  }
  signOut.mockClear()
  setAsStudent.mockClear()
})

describe("AppHeader", () => {
  it("shows the OCELIA brand + UBC crest linking home, for every role", () => {
    renderHeader("student")
    expect(screen.getByText("OCELIA")).toBeInTheDocument()
    const logo = screen.getByRole("img", { name: /university of british columbia/i })
    expect(logo.closest("a")).toHaveAttribute("href", "/")
  })

  it("shows the account label in the banner", () => {
    renderHeader("instructor")
    expect(screen.getByText("instructor@ubc.ca")).toBeInTheDocument()
  })

  it("keeps role navigation OUT of the banner (no Courses/Analytics/Chats links)", () => {
    renderHeader("instructor")
    expect(screen.queryByRole("link", { name: "Courses" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Global Analytics" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Global Chats" })).toBeNull()
  })

  it("opens the account menu and signs out", async () => {
    const user = userEvent.setup()
    renderHeader("student")
    await user.click(screen.getByRole("button", { name: /account menu/i }))
    const signOutItem = await screen.findByRole("menuitem", { name: /sign out/i })
    await user.click(signOutItem)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it("offers 'view as student' in the menu only for instructors", async () => {
    const user = userEvent.setup()
    renderHeader("instructor")
    await user.click(screen.getByRole("button", { name: /account menu/i }))
    expect(await screen.findByRole("menuitem", { name: /view as student/i })).toBeInTheDocument()
  })

  it("does not offer 'view as student' for students", async () => {
    const user = userEvent.setup()
    renderHeader("student")
    await user.click(screen.getByRole("button", { name: /account menu/i }))
    expect(await screen.findByRole("menuitem", { name: /sign out/i })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /view as student/i })).toBeNull()
  })
})
