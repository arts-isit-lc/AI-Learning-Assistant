import { useCallback, useEffect, useRef, useState } from "react"
import { MdCheck, MdContentCopy } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/** Delay before the copy glyph swaps to the checkmark, in ms (Figma 1511:6872). */
export const COPY_CONFIRM_DELAY_MS = 500

/** How long the checkmark stays up before reverting to the copy glyph, in ms. */
export const COPY_CONFIRM_DURATION_MS = 2000

/**
 * Icon button that copies `value` to the clipboard and confirms with a brief
 * checkmark.
 *
 * The clipboard write fires immediately on click — that's the real copy. The
 * icon feedback is deliberately delayed to match the mockup: the copy glyph
 * holds for ~0.5s, swaps to a checkmark that stays up ~2s, then reverts. Because
 * the swap is timer-driven (not tied to the clipboard promise), the confirmation
 * looks the same whether or not the write succeeds — clipboard access is
 * best-effort and can be denied or unavailable (e.g. insecure context).
 *
 * @param {object} props
 * @param {string} props.value Text written to the clipboard on click.
 * @param {string} [props.label="Copy"] Accessible name for the icon-only button.
 * @param {number} [props.size=16] Icon size in px.
 * @param {string} [props.className] Extra classes merged onto the button.
 */
export function CopyButton({ value, label = "Copy", size = 16, className, ...props }) {
  const [copied, setCopied] = useState(false)
  const timers = useRef([])

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  // Cancel any pending swaps if the button unmounts mid-sequence, so a late
  // timer can't call setState on an unmounted component.
  useEffect(() => clearTimers, [clearTimers])

  const handleClick = useCallback(() => {
    if (!value) return
    // Best-effort, fire-and-forget: a rejected or absent clipboard must not
    // throw or block the visual confirmation scheduled below.
    try {
      navigator.clipboard?.writeText(value)?.catch(() => {})
    } catch {
      // Some environments throw synchronously when the clipboard is unavailable.
    }
    // Restart the sequence cleanly on every click: back to the copy glyph, show
    // the checkmark after the delay, then revert once it has been up long enough.
    clearTimers()
    setCopied(false)
    timers.current.push(setTimeout(() => setCopied(true), COPY_CONFIRM_DELAY_MS))
    timers.current.push(
      setTimeout(() => setCopied(false), COPY_CONFIRM_DELAY_MS + COPY_CONFIRM_DURATION_MS)
    )
  }, [value, clearTimers])

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      className={cn(
        // Non-chevron interactive icon: #6829C2 (primary) default, #2E0666
        // (primary-dark) hover, #000 (neutral-900) while pressed.
        "flex rounded p-1 text-primary transition-colors hover:text-primary-dark active:text-neutral-900",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      <Icon icon={copied ? MdCheck : MdContentCopy} size={size} />
    </button>
  )
}
