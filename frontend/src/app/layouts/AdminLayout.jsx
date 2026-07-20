import { Link, NavLink, Outlet, useLocation } from "react-router-dom"
import { MdAdd } from "react-icons/md"
import { AppHeader } from "@/components/composed/AppHeader"
import { AddInstructorDialog } from "@/features/admin/AddInstructorDialog"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

const navLinkClass = ({ isActive }) =>
  cn(
    "-mb-px border-b-2 px-1 pb-2 pt-2 text-caption font-semibold transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-primary"
      : "border-transparent text-muted-foreground hover:text-foreground"
  )

/**
 * Admin shell (`OCELIA/AdminView/*` frames): top banner (brand + account), then
 * the "ADMINISTRATION" title + subtitle, then the `Instructors / Courses` tab
 * row with the section's primary action on the right (Add instructor / Add
 * course), a full-width divider, and the master-detail `Outlet` below. The tabs
 * + action live here (persistent across list and detail), not in the list pane.
 */
export default function AdminLayout() {
  const { pathname } = useLocation()
  const inCourses = pathname.startsWith("/admin/courses")

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader role="admin" />

      <div className="mx-auto w-full max-w-7xl px-6 pt-8">
        <h1 className="text-h2 font-semibold uppercase text-foreground">Administration</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Add and remove instructors, manage access, and create or duplicate new courses.
        </p>
      </div>

      <div className="mt-4 border-b border-border">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6">
          <nav className="flex items-center gap-6" aria-label="Admin navigation">
            <NavLink to="/admin/instructors" className={navLinkClass}>
              Instructors
            </NavLink>
            <NavLink to="/admin/courses" className={navLinkClass}>
              Courses
            </NavLink>
          </nav>
          {inCourses ? (
            <Button asChild size="sm">
              <Link to="/admin/courses/new">
                Add course <Icon icon={MdAdd} size={18} />
              </Link>
            </Button>
          ) : (
            <AddInstructorDialog />
          )}
        </div>
      </div>

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
