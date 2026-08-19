import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/**
 * Numbered pagination — Figma 376:2331 (Chat History footer). A `Previous`
 * button, a sliding window of numbered page buttons (the current page painted
 * brand purple, `bg-primary`), and a `Next` button. `Previous`/`Next` disable at
 * the ends. Pages are 0-indexed on the wire (matching offset math) but rendered
 * 1-indexed. Purely presentational — the parent owns page state and data fetch.
 *
 * @param {object} props
 * @param {number} props.page Current page, 0-indexed.
 * @param {number} props.pageCount Total number of pages (>= 1).
 * @param {(page: number) => void} props.onPageChange Called with the new 0-indexed page.
 * @param {number} [props.maxButtons=5] Max number buttons shown before the window slides.
 * @param {string} [props.className]
 */
export function Pagination({ page, pageCount, onPageChange, maxButtons = 5, className }) {
  if (pageCount <= 1) return null

  // Slide a fixed-size window so the current page stays roughly centred while
  // clamping to [0, pageCount) at the ends.
  const windowSize = Math.min(maxButtons, pageCount)
  let start = Math.max(0, page - Math.floor(windowSize / 2))
  start = Math.min(start, pageCount - windowSize)
  const pages = Array.from({ length: windowSize }, (_, i) => start + i)

  const go = (p) => () => onPageChange(Math.max(0, Math.min(pageCount - 1, p)))

  return (
    <nav aria-label="Pagination" className={cn("flex items-center gap-2", className)}>
      <Button variant="outline" disabled={page === 0} onClick={go(page - 1)}>
        Previous
      </Button>
      {pages.map((p) => {
        const isCurrent = p === page
        return (
          <Button
            key={p}
            size="icon"
            variant={isCurrent ? "default" : "ghost"}
            aria-current={isCurrent ? "page" : undefined}
            aria-label={`Page ${p + 1}`}
            onClick={go(p)}
          >
            {p + 1}
          </Button>
        )
      })}
      <Button variant="outline" disabled={page >= pageCount - 1} onClick={go(page + 1)}>
        Next
      </Button>
    </nav>
  )
}
