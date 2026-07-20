import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import RequireAuth from "./RequireAuth"
import RequireRole from "./RequireRole"

// Control auth state per test without touching Amplify.
let authState
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => authState,
}))

beforeEach(() => {
  authState = {
    isAuthed: false,
    isLoading: false,
    role: null,
    isInstructorAsStudent: false,
  }
})

function renderRoutes(guardRoutes, initialPath) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/courses" element={<div>student home</div>} />
        <Route path="/instructor/courses" element={<div>instructor home</div>} />
        <Route path="/admin/instructors" element={<div>admin home</div>} />
        {guardRoutes}
      </Routes>
    </MemoryRouter>
  )
}

describe("RequireAuth", () => {
  const guard = (
    <Route element={<RequireAuth />}>
      <Route path="/protected" element={<div>protected content</div>} />
    </Route>
  )

  it("renders the child when authenticated", () => {
    authState = { ...authState, isAuthed: true }
    renderRoutes(guard, "/protected")
    expect(screen.getByText("protected content")).toBeInTheDocument()
  })

  it("redirects to /login when unauthenticated", () => {
    renderRoutes(guard, "/protected")
    expect(screen.getByText("login page")).toBeInTheDocument()
  })

  it("shows a loading state while the session resolves", () => {
    authState = { ...authState, isLoading: true }
    renderRoutes(guard, "/protected")
    expect(screen.getByRole("status")).toBeInTheDocument()
  })
})

describe("RequireRole", () => {
  const guard = (
    <Route element={<RequireRole allow={["instructor"]} />}>
      <Route path="/protected" element={<div>instructor area</div>} />
    </Route>
  )

  it("renders the child for an allowed role", () => {
    authState = { ...authState, isAuthed: true, role: "instructor" }
    renderRoutes(guard, "/protected")
    expect(screen.getByText("instructor area")).toBeInTheDocument()
  })

  it("bounces a wrong role to its own home", () => {
    authState = { ...authState, isAuthed: true, role: "student" }
    renderRoutes(guard, "/protected")
    expect(screen.getByText("student home")).toBeInTheDocument()
  })

  it("bounces an admin visiting instructor routes to the admin home", () => {
    authState = { ...authState, isAuthed: true, role: "admin" }
    renderRoutes(guard, "/protected")
    expect(screen.getByText("admin home")).toBeInTheDocument()
  })
})
