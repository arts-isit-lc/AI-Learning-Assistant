import { cn } from "@/lib/utils"

/**
 * Generic list row (courses, instructors, sessions). Interactive when `onClick`
 * is provided (renders a button with hover/focus/selected states); otherwise a
 * plain container.
 */
export function ListRow({ children, onClick, selected = false, className }) {
  const interactive = typeof onClick === "function"
  const Comp = interactive ? "button" : "div"
  return (
    <Comp
      type={interactive ? "button" : undefined}
      onClick={onClick}
      aria-current={interactive && selected ? "true" : undefined}
      className={cn(
        // Flush, divider-separated rows (mockup: master-detail list) — not
        // individually bordered boxes. Each row carries a hairline bottom border;
        // the selected row drops it for a solid, flush (square) brand fill.
        "group flex w-full items-center gap-3 border-b border-border pt-2 pb-4 py-4 text-left transition-colors duration-fast",
        interactive &&
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        interactive && !selected && "hover:bg-accent",
        // Selected = solid brand fill, flush with the list (no border radius).
        // Children with explicit text colours invert via `group-aria-[current=true]:`
        // (in the feature rows); plain-text children inherit `text-primary-foreground`.
        selected && "border-transparent bg-primary text-primary-foreground",
        className
      )}
    >
      {children}
    </Comp>
  )
}
