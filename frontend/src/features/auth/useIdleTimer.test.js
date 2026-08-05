import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useIdleTimer } from "./useIdleTimer"

// Fake timers also mock Date, so Date.now() advances with the timers — which is
// exactly what the hook's timestamp math relies on.
describe("useIdleTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fires onIdle once the inactivity window elapses", () => {
    const onIdle = vi.fn()
    renderHook(() => useIdleTimer({ timeoutMs: 1000, checkIntervalMs: 100, onIdle }))

    expect(onIdle).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1100))
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it("opens the warning window before the deadline without firing onIdle yet", () => {
    const onIdle = vi.fn()
    const onWarn = vi.fn()
    const { result } = renderHook(() =>
      useIdleTimer({ timeoutMs: 1000, warningMs: 400, checkIntervalMs: 100, onIdle, onWarn })
    )

    act(() => vi.advanceTimersByTime(650))
    expect(result.current.warning).toBe(true)
    expect(onWarn).toHaveBeenCalledTimes(1)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it("resets the countdown on user activity", () => {
    const onIdle = vi.fn()
    renderHook(() => useIdleTimer({ timeoutMs: 1000, checkIntervalMs: 100, onIdle }))

    act(() => vi.advanceTimersByTime(800))
    act(() => window.dispatchEvent(new Event("mousemove")))
    // 800ms more would cross 1000 total, but activity reset the clock at 800.
    act(() => vi.advanceTimersByTime(800))
    expect(onIdle).not.toHaveBeenCalled()
    // Now let the (reset) window fully elapse.
    act(() => vi.advanceTimersByTime(300))
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it("ignores passive activity once the warning is showing", () => {
    const onIdle = vi.fn()
    const { result } = renderHook(() =>
      useIdleTimer({ timeoutMs: 1000, warningMs: 500, checkIntervalMs: 100, onIdle })
    )

    act(() => vi.advanceTimersByTime(600)) // remaining 400 <= 500 -> warning
    expect(result.current.warning).toBe(true)
    // A stray mousemove behind the modal must NOT keep the session alive.
    act(() => window.dispatchEvent(new Event("mousemove")))
    act(() => vi.advanceTimersByTime(500))
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it("stayActive() dismisses the warning and pushes the deadline out", () => {
    const onIdle = vi.fn()
    const { result } = renderHook(() =>
      useIdleTimer({ timeoutMs: 1000, warningMs: 400, checkIntervalMs: 100, onIdle })
    )

    act(() => vi.advanceTimersByTime(700))
    expect(result.current.warning).toBe(true)

    act(() => result.current.stayActive())
    expect(result.current.warning).toBe(false)

    act(() => vi.advanceTimersByTime(700))
    expect(onIdle).not.toHaveBeenCalled()
  })

  it("does nothing while disabled", () => {
    const onIdle = vi.fn()
    renderHook(() => useIdleTimer({ timeoutMs: 1000, checkIntervalMs: 100, onIdle, enabled: false }))

    act(() => vi.advanceTimersByTime(5000))
    expect(onIdle).not.toHaveBeenCalled()
  })

  it("removes its listeners and timer on unmount", () => {
    const onIdle = vi.fn()
    const removeSpy = vi.spyOn(window, "removeEventListener")
    const { unmount } = renderHook(() =>
      useIdleTimer({ timeoutMs: 1000, checkIntervalMs: 100, onIdle })
    )

    unmount()
    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function))
    // Timer is torn down: advancing past the deadline must not fire onIdle.
    act(() => vi.advanceTimersByTime(2000))
    expect(onIdle).not.toHaveBeenCalled()
    removeSpy.mockRestore()
  })
})
