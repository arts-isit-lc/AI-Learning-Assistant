import { useCallback, useEffect, useRef, useState } from "react"

/**
 * User activity events that count as "still here". Passive listeners so they
 * never block scrolling/interaction.
 */
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"]

/**
 * Inactivity timer. Fires `onWarn` once when only `warningMs` remains before the
 * `timeoutMs` deadline, then `onIdle` at the deadline. Any user activity (or an
 * explicit `stayActive()`) before the warning resets the countdown; once the
 * warning is showing, only `stayActive()` resets it, so a stray mousemove behind
 * the modal can't silently keep a walked-away user signed in.
 *
 * Implementation is timestamp-based (records `lastActivity` and re-evaluates on
 * an interval + on tab re-focus) rather than a single `setTimeout`, so a
 * background-throttled tab still expires correctly and re-focus is re-checked
 * immediately.
 *
 * Purely client-side — a UX/hygiene control, not a security boundary (the
 * server-side refresh-token cap is the real limit).
 *
 * @param {Object} opts
 * @param {number} opts.timeoutMs - Inactivity window before `onIdle` fires.
 * @param {number} [opts.warningMs=0] - Lead time before the deadline to fire `onWarn` (0 = no warning).
 * @param {() => void} opts.onIdle - Called once when the deadline is reached.
 * @param {() => void} [opts.onWarn] - Called once when the warning window opens.
 * @param {boolean} [opts.enabled=true] - When false, no listeners/timers run.
 * @param {number} [opts.checkIntervalMs=1000] - How often the deadline is re-evaluated.
 * @returns {{ warning: boolean, remainingMs: number, stayActive: () => void }}
 */
export function useIdleTimer({
  timeoutMs,
  warningMs = 0,
  onIdle,
  onWarn,
  enabled = true,
  checkIntervalMs = 1000,
}) {
  const [warning, setWarning] = useState(false)
  const [remainingMs, setRemainingMs] = useState(timeoutMs)

  const lastActivityRef = useRef(Date.now())
  const warnedRef = useRef(false)
  const firedRef = useRef(false)

  // Hold the latest callbacks in refs so activity listeners don't need to be
  // torn down and re-added every time a parent re-renders with new closures.
  const onIdleRef = useRef(onIdle)
  const onWarnRef = useRef(onWarn)
  useEffect(() => {
    onIdleRef.current = onIdle
    onWarnRef.current = onWarn
  }, [onIdle, onWarn])

  const reset = useCallback(() => {
    lastActivityRef.current = Date.now()
    warnedRef.current = false
    firedRef.current = false
    setWarning(false)
    setRemainingMs(timeoutMs)
  }, [timeoutMs])

  useEffect(() => {
    if (!enabled) return undefined

    // Fresh baseline whenever the timer (re)activates or its config changes.
    reset()

    const evaluate = () => {
      if (firedRef.current) return
      const elapsed = Date.now() - lastActivityRef.current
      const remaining = Math.max(0, timeoutMs - elapsed)

      if (elapsed >= timeoutMs) {
        firedRef.current = true
        setWarning(false)
        onIdleRef.current?.()
        return
      }

      if (warningMs > 0 && remaining <= warningMs) {
        if (!warnedRef.current) {
          warnedRef.current = true
          setWarning(true)
          onWarnRef.current?.()
        }
        // Only drive per-tick re-renders while the countdown is visible.
        setRemainingMs(remaining)
      }
    }

    const onActivity = () => {
      // Before the warning, activity keeps the session alive. Once the warning
      // is up (or we've already fired), require an explicit stayActive().
      if (warnedRef.current || firedRef.current) return
      lastActivityRef.current = Date.now()
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") evaluate()
    }

    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, onActivity, { passive: true })
    )
    document.addEventListener("visibilitychange", onVisibility)
    const intervalId = setInterval(evaluate, checkIntervalMs)

    return () => {
      clearInterval(intervalId)
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, onActivity))
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, timeoutMs, warningMs, checkIntervalMs, reset])

  return { warning, remainingMs, stayActive: reset }
}
