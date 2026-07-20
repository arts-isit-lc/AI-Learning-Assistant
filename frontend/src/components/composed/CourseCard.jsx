import { cn } from "@/lib/utils"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

/**
 * Course tile (Figma Card/Course). Interactive when `onOpen` is provided (the
 * whole card is a keyboard-operable button). `state="inactive"` dims it.
 *
 * @param {{ course: { course_department?: string, course_number?: string|number, course_name?: string }, onOpen?: () => void, state?: "default"|"inactive", className?: string }} props
 */
export function CourseCard({ course, onOpen, state = "default", className }) {
  const dept = String(course?.course_department ?? "").toUpperCase()
  const number = course?.course_number ?? ""
  const name = course?.course_name ?? "Untitled course"
  const inactive = state === "inactive"
  const interactive = typeof onOpen === "function" && !inactive

  return (
    <Card
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
        "flex min-h-32 flex-col justify-between gap-4 p-6 transition-shadow",
        interactive &&
          "cursor-pointer hover:shadow-modal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        inactive && "opacity-60",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-h4 font-semibold text-navy">
            {dept} {number}
          </span>
          <span className="text-caption text-muted-foreground">{name}</span>
        </div>
        {inactive && <Badge variant="secondary">Inactive</Badge>}
      </div>
    </Card>
  )
}
