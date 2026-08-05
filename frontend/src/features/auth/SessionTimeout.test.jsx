import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Hoisted mocks: control auth state and the idle-timer output directly so this
// suite tests the component's rendering + button wiring in isolation (the timer
// logic itself is covered by useIdleTimer.test.js).
const { useAuthMock, idle, stayActive } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  idle: { warning: false, remainingMs: 60000, opts: null },
  stayActive: vi.fn(),
}))

vi.mock("@/context/AuthContext", () => ({ useAuth: () => useAuthMock() }))
vi.mock("./useIdleTimer", () => ({
  useIdleTimer: (opts) => {
    idle.opts = opts
    return { warning: idle.warning, remainingMs: idle.remainingMs, stayActive }
  },
}))

import { SessionTimeout } from "./SessionTimeout"

describe("SessionTimeout", () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({ isAuthed: true, signOut: vi.fn() })
    idle.warning = false
    idle.remainingMs = 60000
    idle.opts = null
    stayActive.mockReset()
  })

  it("renders nothing when the user is not signed in", () => {
    useAuthMock.mockReturnValue({ isAuthed: false, signOut: vi.fn() })
    const { container } = render(<SessionTimeout />)
    expect(container).toBeEmptyDOMElement()
  })

  it("enables the idle timer and wires onIdle to signOut when authed", () => {
    const signOut = vi.fn()
    useAuthMock.mockReturnValue({ isAuthed: true, signOut })
    render(<SessionTimeout />)

    expect(idle.opts.enabled).toBe(true)
    expect(idle.opts.onIdle).toBe(signOut)
    expect(idle.opts.timeoutMs).toBe(30 * 60 * 1000)
    expect(idle.opts.warningMs).toBe(60 * 1000)
  })

  it("keeps the warning dialog closed until the warning window opens", () => {
    render(<SessionTimeout />)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("shows a countdown in the warning dialog", () => {
    idle.warning = true
    idle.remainingMs = 30000
    render(<SessionTimeout />)

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/signed out in\s+30 seconds/i)).toBeInTheDocument()
  })

  it("uses the singular unit at one second remaining", () => {
    idle.warning = true
    idle.remainingMs = 1000
    render(<SessionTimeout />)
    expect(screen.getByText(/signed out in\s+1 second\b/i)).toBeInTheDocument()
  })

  it("'Stay signed in' resets the timer; 'Sign out' signs out", async () => {
    const signOut = vi.fn()
    useAuthMock.mockReturnValue({ isAuthed: true, signOut })
    idle.warning = true
    const user = userEvent.setup()
    render(<SessionTimeout />)

    await user.click(screen.getByRole("button", { name: /stay signed in/i }))
    expect(stayActive).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole("button", { name: /^sign out$/i }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
