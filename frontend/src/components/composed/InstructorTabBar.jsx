import { useEffect, useState } from "react"
import { NavLink, useMatch } from "react-router-dom"
import { MdExpandLess, MdExpandMore } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

const TABS = [
  { to: "/instructor/courses", label: "Courses" },
  { to: "/instructor/analytics", label: "Global Analytics" },
  { to: "/instructor/chats", label: "Global Chats" },
]

const tabClass = ({ isActive }) =>
  cn(
    "-mb-px border-b-2 px-6 pb-2 text-caption font-semibold transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-primary"
      : "border-transparent text-muted-foreground hover:text-foreground"
  )

const toggleClass =
  "flex items-center gap-1 rounded-md text-base leading-7 text-primary underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

/**
 * Instructor navigation bar (`Header/Instructor` frame 859:7380) — sits directly
 * below the top banner in `InstructorLayout`. This is NOT part of the banner:
 * the `Courses / Global Analytics / Global Chats` tabs belong here, not in
 * `AppHeader`.
 *
 * Two states from the frames:
 *  - Expanded (Default, ~154px): greeting + subtitle, then the tab row, with a
 *    Collapse toggle.
 *  - Collapsed (Variant2, ~28px): just the tab row + an Expand toggle.
 *
 * Auto-collapses when a course is open (the course workspace needs the vertical
 * space); the toggle overrides until the next navigation. The `Quicklink?`
 * button from the frame is dropped — it was a placeholder with no defined target.
 */
export function InstructorTabBar() {
  const inCourse = Boolean(useMatch("/instructor/courses/:courseId/*"))
  const [expanded, setExpanded] = useState(!inCourse)

  // Follow the route: expand on the landing, collapse inside a course. The
  // toggle can override until the next navigation flips `inCourse`.
  useEffect(() => {
    setExpanded(!inCourse)
  }, [inCourse])

  const tabs = (
    <nav className="flex items-center gap-6" aria-label="Instructor navigation">
      {TABS.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={tabClass}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6">
        {/* Greeting/subtitle — slides open/closed like the accordions (grid-rows
            0fr<->1fr + fade, var(--transition-normal) / var(--ease-standard),
            reduced-motion aware). Kept mounted so it animates BOTH directions;
            aria-hidden while collapsed keeps it out of the a11y tree (the panel
            has no focusable content, so no inert/tab-order handling is needed). */}
        <div
          id="instructor-greeting"
          className={cn(
            "grid transition-[grid-template-rows] duration-normal ease-standard motion-reduce:transition-none",
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="overflow-hidden">
            <div
              aria-hidden={!expanded}
              className={cn(
                "pt-5 transition-opacity duration-normal ease-standard motion-reduce:transition-none",
                expanded ? "opacity-100" : "opacity-0"
              )}
            >
              <h1 className="text-h2 font-semibold uppercase text-foreground">Hi, Instructor!</h1>
              <p className="mt-1 text-body text-muted-foreground">
                Manage your courses, upload materials, and review chat activity and insights.
              </p>
            </div>
          </div>
        </div>

        {/* Persistent tab row + the Expand/Collapse toggle. */}
        <div className="flex items-center justify-between py-6">
          {tabs}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={toggleClass}
            aria-expanded={expanded}
            aria-controls="instructor-greeting"
          >
            {expanded ? "Collapse" : "Expand"}
            <Icon icon={expanded ? MdExpandLess : MdExpandMore} size={18} />
          </button>
        </div>
      </div>
    </div>
  )
}
