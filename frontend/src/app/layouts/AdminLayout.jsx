import { NavLink, Outlet } from "react-router-dom"
import { AppHeader } from "@/components/composed/AppHeader"
import { cn } from "@/lib/utils"

const navLinkClass = ({ isActive }) =>
  cn(
    "-mb-px border-b-2 px-1 pb-2 text-caption font-semibold transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-primary"
      : "border-transparent text-muted-foreground hover:text-foreground"
  )

/**
 * Admin shell: top banner (brand + account) + the Instructors / Courses nav.
 * The nav lives here (below the banner), not in `AppHeader` — matching the
 * frame split where the banner is brand + account only.
 */
export default function AdminLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader role="admin" />
      <div className="border-b border-border bg-background">
        <nav
          className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-2"
          aria-label="Admin navigation"
        >
          <NavLink to="/admin/instructors" className={navLinkClass}>
            Instructors
          </NavLink>
          <NavLink to="/admin/courses" className={navLinkClass}>
            Courses
          </NavLink>
        </nav>
      </div>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
