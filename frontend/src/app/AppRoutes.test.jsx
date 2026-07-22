import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { routes } from "./AppRoutes"

// Control role/auth without Amplify; stub the heavy lazy screens so the test
// stays focused on routing (not the real Login / the token gallery).
let authState
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => authState,
}))
vi.mock("@/features/auth/Login", () => ({ default: () => <div>login page</div> }))
vi.mock("@/pages/dev/StyleGuide", () => ({ default: () => <div>style guide</div> }))
// Student feature screens (named exports, loaded lazily by AppRoutes). Stubbed
// so routing tests don't run their real Query hooks without a QueryClient.
vi.mock("@/features/student/StudentHome", () => ({ StudentHome: () => <div>student home</div> }))
vi.mock("@/features/student/CourseView", () => ({ CourseView: () => <div>course view</div> }))
vi.mock("@/features/student/StudentChat", () => ({ StudentChat: () => <div>module chat</div> }))
// Instructor feature screens (named exports, loaded lazily by AppRoutes).
vi.mock("@/features/instructor/InstructorCourseList", () => ({
  InstructorCourseList: () => <div>instructor course list</div>,
}))
vi.mock("@/features/instructor/ConfigurationTab", () => ({
  ConfigurationTab: () => <div>configuration tab</div>,
}))
vi.mock("@/features/admin/InstructorList", () => ({ InstructorList: () => <div>instructor list</div> }))
vi.mock("@/features/admin/InstructorDetail", () => ({ InstructorDetail: () => <div>instructor detail</div> }))

beforeEach(() => {
  authState = {
    isAuthed: true,
    isLoading: false,
    role: "student",
    isInstructorAsStudent: false,
    signOut: vi.fn(),
    setIsInstructorAsStudent: vi.fn(),
  }
})

// The app now uses a data router (createBrowserRouter + RouterProvider) so
// useBlocker works app-wide. Tests exercise the SAME route tree via
// createMemoryRouter, seeded to the target path. The route tree's RootLayout
// supplies CourseProvider + the Suspense boundary, so the harness only needs a
// QueryClient (the instructor course layout reads live Query hooks — course
// meta + prompt conflict dot). A fresh client per render with retries off keeps
// tests isolated and fast; unmocked queryFns settle to an (ignored) error state.
function renderAt(path) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

describe("AppRoutes — student", () => {
  it("renders a deep-linked module chat on a cold mount (refresh-safe)", async () => {
    renderAt("/courses/c1/modules/m1")
    expect(await screen.findByText("module chat")).toBeInTheDocument()
    // shell renders for the role
    expect(screen.getByText("OCELIA")).toBeInTheDocument()
  })

  it("redirects '/' to the student home", async () => {
    renderAt("/")
    expect(await screen.findByText("student home")).toBeInTheDocument()
  })
})

describe("AppRoutes — role guards", () => {
  it("bounces a student away from instructor routes to their own home", async () => {
    authState = { ...authState, role: "student" }
    renderAt("/instructor/courses")
    expect(await screen.findByText("student home")).toBeInTheDocument()
  })

  it("defaults the instructor course area to the Configuration tab, list pane persisting", async () => {
    authState = { ...authState, role: "instructor" }
    renderAt("/instructor/courses/c1")
    expect(await screen.findByText("configuration tab")).toBeInTheDocument()
    // master-detail: the course list pane stays mounted alongside the detail
    expect(screen.getByText("instructor course list")).toBeInTheDocument()
  })

  it("lets an admin reach a deep-linked instructor detail (master-detail)", async () => {
    authState = { ...authState, role: "admin" }
    renderAt("/admin/instructors/i1")
    expect(await screen.findByText("instructor detail")).toBeInTheDocument()
    // the list pane persists alongside the detail
    expect(screen.getByText("instructor list")).toBeInTheDocument()
  })
})

describe("AppRoutes — 404 + legacy redirects", () => {
  it("shows a 404 for an unknown path", async () => {
    renderAt("/nope/nope")
    expect(await screen.findByRole("heading", { name: "404" })).toBeInTheDocument()
  })

  it("redirects the legacy /student_chat route to the student home", async () => {
    renderAt("/student_chat/whatever")
    expect(await screen.findByText("student home")).toBeInTheDocument()
  })

  it("redirects the legacy /course route to the instructor courses list", async () => {
    authState = { ...authState, role: "instructor" }
    renderAt("/course/anything")
    expect(await screen.findByText("instructor course list")).toBeInTheDocument()
  })
})

describe("AppRoutes — public", () => {
  it("renders the login screen (unauthenticated allowed)", async () => {
    authState = { ...authState, isAuthed: false, role: null }
    renderAt("/login")
    expect(await screen.findByText("login page")).toBeInTheDocument()
  })
})
