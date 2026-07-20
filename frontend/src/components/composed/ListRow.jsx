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
        "group flex w-full items-center gap-3 rounded-md border border-border px-4 py-3 text-left transition-colors",
        interactive &&
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        interactive && !selected && "hover:bg-accent",
        // Selected = solid brand fill (frame: master-detail list). Children with
        // explicit text colours invert via `group-aria-[current=true]:` (below);
        // plain-text children inherit `text-primary-foreground` here.
        selected && "border-primary bg-primary text-primary-foreground",
        className
      )}
    >
      {children}
    </Comp>
  )
}
