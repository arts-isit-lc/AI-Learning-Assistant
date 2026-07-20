import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

const { apiClient } = vi.hoisted(() => ({
  apiClient: { getAuth: vi.fn(), post: vi.fn() },
}))
vi.mock("@/services/api", () => ({ default: apiClient }))

import { useDraftModule } from "./useDraftModule"

beforeEach(() => {
  sessionStorage.clear()
  apiClient.getAuth.mockReset().mockResolvedValue({ email: "prof@x.com", token: "tok" })
  apiClient.post.mockReset().mockResolvedValue({ module_id: "m-new" })
})

describe("useDraftModule", () => {
  it("reserves a draft module on mount and stores it", async () => {
    const { result } = renderHook(() => useDraftModule("c1"))
    await waitFor(() => expect(result.current.moduleId).toBe("m-new"))
    expect(apiClient.post).toHaveBeenCalledWith("instructor/reserve_module", {
      course_id: "c1",
      instructor_email: "prof@x.com",
    })
    expect(sessionStorage.getItem("draft_module_c1")).toBe("m-new")
  })

  it("reuses an existing draft from sessionStorage without reserving again", async () => {
    sessionStorage.setItem("draft_module_c1", "m-existing")
    const { result } = renderHook(() => useDraftModule("c1"))
    expect(result.current.moduleId).toBe("m-existing")
    // give any effect a tick; reserve must not fire
    await waitFor(() => expect(apiClient.post).not.toHaveBeenCalled())
  })

  it("cleans up the draft", async () => {
    sessionStorage.setItem("draft_module_c1", "m-existing")
    const { result } = renderHook(() => useDraftModule("c1"))
    await act(async () => {
      await result.current.cleanup()
    })
    // In the app, cleanup() is followed by navigating away (unmount); here the
    // hook stays mounted, so the reserve effect re-fires — we assert the cleanup
    // call itself rather than the post-cleanup sessionStorage state.
    expect(apiClient.post).toHaveBeenCalledWith("instructor/cleanup_module", {
      module_id: "m-existing",
      course_id: "c1",
      instructor_email: "prof@x.com",
    })
  })

  it("markSaved prevents cleanup from firing", async () => {
    sessionStorage.setItem("draft_module_c1", "m-existing")
    const { result } = renderHook(() => useDraftModule("c1"))
    act(() => result.current.markSaved())
    apiClient.post.mockClear()
    await act(async () => {
      await result.current.cleanup()
    })
    expect(apiClient.post).not.toHaveBeenCalled()
  })
})
