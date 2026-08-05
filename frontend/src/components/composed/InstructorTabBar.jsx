import { useEffect, useState } from "react"
import { NavLink, useMatch } from "react-router-dom"
import { MdExpandLess, MdExpandMore } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Collapse } from "@/components/ui/collapse"

const TABS = [
  { to: "/instructor/courses", label: "Courses" },
  { to: "/instructor/analytics", label: "Global Analytics" },
  { to: "/instructor/chats", label: "Global Chats" },
]

// Mirrors the admin nav tabs exactly (AdminLayout `navLinkClass`): the active
// tab is black (#000 / neutral-900) with a border-primary underline and no
// hover; inactive tabs are brand purple (text-primary) and take the rounded
// brand-"lightest" hover fill (#F2E8FF / --primary-subtle) with "Faculty of
// Arts/Dark" text (#2E0666 / --primary-dark).
const tabClass = ({ isActive }) =>
  cn(
    "border-b-2 py-1 px-6 text-caption font-semibold text-sm transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-neutral-900"
      : "rounded border-transparent text-primary hover:bg-primary-subtle hover:text-primary-dark"
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

  // One button, rendered in whichever slot the current state uses (top-right when
  // expanded, inline with the tabs when collapsed) — matches the frames.
  const toggleButton = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={toggleClass}
      aria-expanded={expanded}
      aria-controls="instructor-greeting"
    >
      {expanded ? "Collapse" : "Expand"}
      <Icon icon={expanded ? MdExpandLess : MdExpandMore} size={24} />
    </button>
  )

  return (
    <div className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6">
        {/* Top row: greeting/subtitle with the Collapse toggle pinned top-right
            while expanded. The greeting slides via the shared Collapse primitive
            (same motion as every accordion); collapsed, it's height 0 so this row
            disappears and only the tab row shows. */}
        <div className="flex items-start justify-between gap-4">
          <Collapse open={expanded} className="flex-1" id="instructor-greeting">
            <div className="pt-5">
              <h1 className="text-h2 font-semibold uppercase text-foreground">Hi, Instructor!</h1>
              <p className="mt-1 text-body text-muted-foreground">
                Manage your courses, upload materials, and review chat activity and insights.
              </p>
            </div>
          </Collapse>
          {expanded && <div className="shrink-0 pt-5">{toggleButton}</div>}
        </div>

        {/* Tab row (persistent). Collapsed: the toggle moves inline with the tabs
            for the compact single-row layout. */}
        <div className="flex items-center justify-between py-6">
          {tabs}
          {!expanded && toggleButton}
        </div>
      </div>
    </div>
  )
}
