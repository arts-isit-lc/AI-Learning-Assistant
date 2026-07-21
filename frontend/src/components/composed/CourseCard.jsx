import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

/** Status label text + colour, matching the Figma Card/Course states. */
const STATUS_LABEL = {
  completed: "COMPLETED",
  in_progress: "IN PROGRESS",
  access_requested: "ACCESS REQUESTED",
}
const STATUS_CLASS = {
  completed: "text-success",
  in_progress: "text-info",
  access_requested: "text-white",
}

/**
 * Course tile — Figma `Card/Course` (859:6653). Presentational only; the parent
 * supplies progress/status. Matches the frame: 4px radius, #808080 border, FLAT
 * (no shadow), 16px padding. Layout = course code (semibold) + name, a hairline
 * divider, then `NN% (x/y concepts completed)` on the left + a status label on
 * the right. States: Default / Hover (lightest-purple bg + purple border) /
 * Inactive (grey fill + white text).
 *
 * @param {{
 *   code: string,
 *   name?: string,
 *   progress?: { percent: number, completed: number, total: number } | null,
 *   status?: "completed"|"in_progress"|"access_requested",
 *   state?: "default"|"inactive",
 *   loading?: boolean,
 *   onOpen?: () => void,
 *   className?: string,
 * }} props
 */
export function CourseCard({
  code,
  name,
  progress = null,
  status,
  state = "default",
  loading = false,
  onOpen,
  className,
}) {
  const inactive = state === "inactive"
  const interactive = typeof onOpen === "function" && !inactive
  const showProgress = loading || progress || status

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onOpen()
              }
            }
          : undefined
      }
      aria-disabled={inactive || undefined}
      className={cn(
        "flex flex-col gap-6 rounded-sm border border-border p-4 transition-colors",
        inactive ? "bg-neutral-300 text-white" : "bg-card text-neutral-900",
        interactive &&
          "cursor-pointer hover:border-primary hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="text-h4 font-semibold leading-7">{code}</span>
        {name && <span className="text-caption leading-7">{name}</span>}
      </div>

      {showProgress && (
        <div className="flex flex-col gap-2">
          <div
            className={cn("h-px w-full", inactive ? "bg-white/50" : "bg-[hsl(var(--border-subtle))]")}
            aria-hidden="true"
          />
          <div className="flex items-center justify-between gap-2 text-caption leading-7">
            {loading ? (
              <Skeleton className="h-4 w-44" />
            ) : progress ? (
              <span className="flex items-center gap-1">
                <span className="font-semibold">{progress.percent}%</span>
                <span>
                  ({progress.completed}/{progress.total} concepts completed)
                </span>
              </span>
            ) : (
              <span />
            )}
            {status && (
              <span className={cn("font-semibold", inactive ? "text-white" : STATUS_CLASS[status])}>
                {STATUS_LABEL[status]}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
