import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { isChunkLoadError, RouteError } from "./RouteError"

// The only react-router surface RouteError touches is useRouteError; drive it
// per-test. (LoadingScreen / ErrorState pull in no router APIs.)
let routeError
vi.mock("react-router", () => ({
  useRouteError: () => routeError,
}))

// jsdom's window.location.reload throws "Not implemented", so swap window.location
// for a spy we can assert on and restore afterward.
const originalLocation = window.location
let reloadSpy

beforeEach(() => {
  routeError = null
  sessionStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  reloadSpy = vi.fn()
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  })
})

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
  vi.restoreAllMocks()
})

describe("isChunkLoadError", () => {
  it("matches the browser-specific dynamic-import failure messages", () => {
    for (const msg of [
      "Failed to fetch dynamically imported module: https://x/assets/A-abc.js",
      "error loading dynamically imported module: https://x/assets/A-abc.js",
      "Importing a module script failed.",
    ]) {
      expect(isChunkLoadError(new TypeError(msg))).toBe(true)
    }
  })

  it("does not match unrelated errors or nullish values", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe("RouteError", () => {
  it("reloads once and shows a spinner on a stale-chunk error", () => {
    routeError = new TypeError(
      "Failed to fetch dynamically imported module: https://x/assets/InstructorCourseList-abc.js"
    )
    render(<RouteError />)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    // Spinner (LoadingScreen) while the reload takes over — not the error screen.
    expect(screen.getByRole("status")).toBeInTheDocument()
    // The label must render a real ellipsis, NOT the literal escape "\u2026"
    // (a JSX string attribute would not decode the escape — that showed the
    // "\u2026" garbage centered on screen when navigating back after a deploy).
    expect(screen.getByText("Updating to the latest version\u2026")).toBeInTheDocument()
    expect(screen.queryByText(/\\u2026/)).not.toBeInTheDocument()
  })

  it("does not reload again for a repeat chunk error within the window — shows the error screen (no loop)", () => {
    // A reload just happened; a second stale-chunk hit must not loop.
    sessionStorage.setItem("ocelia:chunk-reload-at", String(Date.now()))
    routeError = new TypeError("Failed to fetch dynamically imported module: https://x/assets/A-abc.js")
    render(<RouteError />)
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("Couldn't load the latest version")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("shows a generic error screen (no reload) for a non-chunk error", () => {
    routeError = new Error("Something unexpected blew up")
    render(<RouteError />)
    expect(reloadSpy).not.toHaveBeenCalled()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("reloads from the error screen's Reload button", async () => {
    routeError = new Error("boom")
    const user = userEvent.setup()
    render(<RouteError />)
    await user.click(screen.getByRole("button", { name: "Reload" }))
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })
})
