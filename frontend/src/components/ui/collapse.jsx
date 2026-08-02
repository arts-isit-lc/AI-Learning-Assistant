import { cn } from "@/lib/utils"

/**
 * Collapse — a height + fade "accordion" slide for a single show/hide region.
 *
 * Matches the app's Accordion motion: a `grid-template-rows: 0fr ↔ 1fr`
 * transition on the shared `--transition-normal` / `--ease-standard` tokens,
 * plus an opacity fade. Content stays mounted so it animates in BOTH directions;
 * while closed it collapses to height 0, fades out, is hidden from assistive
 * tech (`aria-hidden`), and is removed from the tab order (`inert`).
 * Reduced-motion users get an instant open/close (`motion-reduce`).
 *
 * Use this for bespoke collapsibles — a single region toggled by a button
 * (Reduce/Expand headers, the Learning Journey drawer, "Module materials", …).
 * For multi-item accordion lists use the `Accordion` primitive; it shares the
 * same motion tokens, so the two read identically.
 *
 * @param {object} props
 * @param {boolean} props.open Whether the region is expanded.
 * @param {React.ReactNode} props.children Content to reveal.
 * @param {string} [props.className] Extra classes for the outer (grid) element — e.g. `flex-1`.
 * @param {string} [props.contentClassName] Extra classes for the inner (clipped) wrapper.
 */
export function Collapse({ open, children, className, contentClassName, ...props }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-normal ease-standard motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "overflow-hidden transition-opacity duration-normal ease-standard motion-reduce:transition-none",
          open ? "opacity-100" : "opacity-0",
          contentClassName
        )}
        aria-hidden={!open || undefined}
        {...(!open && { inert: "" })}
      >
        {children}
      </div>
    </div>
  )
}
