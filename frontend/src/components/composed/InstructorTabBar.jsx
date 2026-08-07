import { NavLink } from "react-router"
import { cn } from "@/lib/utils"

const TABS = [
  { to: "/instructor/courses", label: "Courses" },
  { to: "/instructor/analytics", label: "Global Analytics" },
  { to: "/instructor/chats", label: "Global Chats" },
]

// Mirrors the admin nav tabs exactly (AdminLayout `navLinkClass`). Inactive tabs
// are brand purple (text-primary) at a 4px radius with no fill; hover paints the
// brand-"lightest" surface (#F2E8FF / --primary-subtle) with "Faculty of
// Arts/Dark" text (#2E0666 / --primary-dark); the press (active) deepens the
// surface to #AA78F0 (--primary-active), keeping the #2E0666 text. The selected
// tab is black (#000 / neutral-900) with a 3px --primary underline and no fill or
// hover. The 3px bottom border is reserved on every tab (transparent when
// inactive) so selecting one never shifts the row.
const tabClass = ({ isActive }) =>
  cn(
    "border-b-[3px] py-1 px-6 text-caption font-semibold text-sm transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-neutral-900"
      : "rounded border-transparent text-primary hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark"
  )

/**
 * Instructor navigation bar (`Header/Instructor` frame 859:7380) — sits directly
 * below the top banner in `InstructorLayout`. This is NOT part of the banner:
 * the `Courses / Global Analytics / Global Chats` tabs belong here, not in
 * `AppHeader`.
 *
 * The greeting/subtitle is always visible (no Expand/Collapse toggle). The
 * `Quicklink?` button from the frame is dropped — it was a placeholder with no
 * defined target.
 */
export function InstructorTabBar() {
  return (
    <div className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6">
        {/* Greeting — always visible. */}
        <div className="pt-5">
          <h1 className="text-h2 font-semibold uppercase text-foreground">Hi, Instructor!</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Manage your courses, upload materials, and review chat activity and insights.
          </p>
        </div>

        {/* Tab row. */}
        <nav className="flex items-center gap-6 py-6" aria-label="Instructor navigation">
          {TABS.map((tab) => (
            <NavLink key={tab.to} to={tab.to} className={tabClass}>
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
