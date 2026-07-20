import { Link } from "react-router-dom"
import { MdChevronRight } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Breadcrumb trail (supports the no-dead-ends rule). Each item: `{ label, to? }`.
 * The last item is the current page (not a link).
 *
 * @param {{ items: Array<{ label: string, to?: string }>, className?: string }} props
 */
export function Breadcrumb({ items = [], className }) {
  return (
    <nav aria-label="Breadcrumb" className={cn("text-caption text-muted-foreground", className)}>
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((item, i) => {
          const isLast = i === items.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1">
              {item.to && !isLast ? (
                <Link
                  to={item.to}
                  className="rounded hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={cn(isLast && "font-semibold text-foreground")}
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              )}
              {!isLast && <Icon icon={MdChevronRight} size={16} className="opacity-60" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
