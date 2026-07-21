import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { AuthProvider, useAuth, deriveRole } from "./AuthContext"

const fetchAuthSession = vi.fn()
const signOut = vi.fn()
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: (...args) => fetchAuthSession(...args),
  signOut: (...args) => signOut(...args),
}))

function Probe() {
  const { role, isAuthed, isLoading, user } = useAuth()
  return (
    <div>
      <span data-testid="role">{role ?? "none"}</span>
      <span data-testid="authed">{String(isAuthed)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="email">{user?.email ?? "none"}</span>
    </div>
  )
}

describe("deriveRole", () => {
  it("prioritises admin / techadmin over other groups", () => {
    expect(deriveRole(["student", "admin"])).toBe("admin")
    expect(deriveRole(["techadmin"])).toBe("admin")
  })

  it("maps instructor and student", () => {
    expect(deriveRole(["instructor"])).toBe("instructor")
    expect(deriveRole(["student"])).toBe("student")
  })

  it("returns null when there is no known group", () => {
    expect(deriveRole([])).toBeNull()
    expect(deriveRole(undefined)).toBeNull()
    expect(deriveRole(["some-other-group"])).toBeNull()
  })
})

describe("AuthProvider", () => {
  beforeEach(() => {
    fetchAuthSession.mockReset()
    signOut.mockReset()
  })

  it("exposes the role derived from the Cognito session", async () => {
    fetchAuthSession.mockResolvedValue({
      tokens: {
        accessToken: { payload: { "cognito:groups": ["instructor"], email: "x@y.z" } },
      },
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false")
    )
    expect(screen.getByTestId("role")).toHaveTextContent("instructor")
    expect(screen.getByTestId("authed")).toHaveTextContent("true")
  })

  it("treats a missing session as logged out", async () => {
    fetchAuthSession.mockResolvedValue({ tokens: undefined })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false")
    )
    expect(screen.getByTestId("role")).toHaveTextContent("none")
    expect(screen.getByTestId("authed")).toHaveTextContent("false")
  })

  it("sources the account email from the ID token, not the access token username", async () => {
    // Repro: the access token carries only the Cognito username (a UUID) and
    // groups; the email lives on the ID token. Before the fix the header showed
    // the UUID.
    fetchAuthSession.mockResolvedValue({
      tokens: {
        accessToken: {
          payload: { "cognito:groups": ["student"], username: "9f8c1e02-uuid" },
        },
        idToken: { payload: { email: "student@ubc.ca" } },
      },
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("loading")).toHaveTextContent("false")
    )
    expect(screen.getByTestId("email")).toHaveTextContent("student@ubc.ca")
    expect(screen.getByTestId("role")).toHaveTextContent("student")
  })
})
