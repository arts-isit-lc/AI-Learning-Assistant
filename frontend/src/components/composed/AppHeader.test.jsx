import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router"
import { AppHeader } from "./AppHeader"

const { signOut, setAsStudent, navigate } = vi.hoisted(() => ({
  signOut: vi.fn(),
  setAsStudent: vi.fn(),
  navigate: vi.fn(),
}))

let authState
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => authState,
}))

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => navigate,
}))

// AppHeader reads the role (and the preview flag) from AuthContext — no role
// prop. `asStudent` models an instructor previewing the student UI: role stays
// "instructor" while the flag is on.
function renderHeader(role, { asStudent = false } = {}) {
  authState.role = role
  authState.isInstructorAsStudent = asStudent
  return render(
    <MemoryRouter>
      <AppHeader />
    </MemoryRouter>
  )
}

beforeEach(() => {
  authState = {
    user: { email: "instructor@ubc.ca" },
    role: "instructor",
    signOut,
    isInstructorAsStudent: false,
    setIsInstructorAsStudent: setAsStudent,
  }
  signOut.mockClear()
  setAsStudent.mockClear()
  navigate.mockClear()
})

describe("AppHeader", () => {
  it("shows the OCELIA brand + UBC crest linking home, for every role", () => {
    renderHeader("student")
    expect(screen.getByRole("img", { name: "OCELIA" })).toBeInTheDocument()
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

  it("enters the student view: sets the flag and navigates to the student home", async () => {
    const user = userEvent.setup()
    renderHeader("instructor")
    await user.click(screen.getByRole("button", { name: /account menu/i }))
    await user.click(await screen.findByRole("menuitem", { name: /view as student/i }))
    expect(setAsStudent).toHaveBeenCalledWith(true)
    expect(navigate).toHaveBeenCalledWith("/courses")
  })

  it("shows 'Exit student view' while previewing (student layout) and returns to the instructor home", async () => {
    const user = userEvent.setup()
    // Instructor previewing: on the student route, so userRole is "student",
    // but the real role stays "instructor" and the flag is on.
    renderHeader("instructor", { asStudent: true })
    await user.click(screen.getByRole("button", { name: /account menu/i }))
    const exit = await screen.findByRole("menuitem", { name: /exit student view/i })
    await user.click(exit)
    expect(setAsStudent).toHaveBeenCalledWith(false)
    expect(navigate).toHaveBeenCalledWith("/instructor/courses")
  })

  it("styles the account menu to the mockup: 180px card, black email header, purple rows with a primary-subtle hover", async () => {
    const user = userEvent.setup()
    renderHeader("instructor")
    await user.click(screen.getByRole("button", { name: /account menu/i }))

    // 180px card (Figma Modal/UserAccount 1679:7719).
    const menu = await screen.findByRole("menu")
    expect(menu).toHaveClass("w-[180px]")

    // Black email header, divided from the rows below.
    const header = within(menu).getByText("instructor@ubc.ca")
    expect(header).toHaveClass("text-neutral-900", "border-b", "border-border")

    // Purple rows that fill with #F2E8FF (primary-subtle) on hover/focus.
    const viewAs = screen.getByRole("menuitem", { name: /view as student/i })
    expect(viewAs).toHaveClass("text-primary", "hover:bg-primary-subtle", "focus:bg-primary-subtle")
    const signOutItem = screen.getByRole("menuitem", { name: /sign out/i })
    expect(signOutItem).toHaveClass("text-primary", "hover:bg-primary-subtle", "focus:bg-primary-subtle")
  })
})
