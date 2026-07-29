import { cn } from "@/lib/utils"

/**
 * Three dots that fade in sequence — a lightweight "in progress" affordance for
 * status text (e.g. "Analyzing content" while a file is processing).
 *
 * Decorative: `aria-hidden` so screen readers announce only the adjacent label,
 * not "dot dot dot". Respects `prefers-reduced-motion` — the dots render static
 * (full opacity) instead of animating.
 */
export function AnimatedEllipsis({ className }) {
  return (
    <span className={cn("inline", className)} aria-hidden="true" data-testid="animated-ellipsis">
      <span className="animate-ellipsis-bounce motion-reduce:animate-none">.</span>
      <span className="animate-ellipsis-bounce [animation-delay:200ms] motion-reduce:animate-none">.</span>
      <span className="animate-ellipsis-bounce [animation-delay:400ms] motion-reduce:animate-none">.</span>
    </span>
  )
}
