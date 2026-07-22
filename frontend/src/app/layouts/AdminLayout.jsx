import { Link, NavLink, Outlet, useLocation } from "react-router-dom"
import { MdAdd, MdContentCopy } from "react-icons/md"
import { AppHeader } from "@/components/composed/AppHeader"
import { AddInstructorDialog } from "@/features/admin/AddInstructorDialog"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/**
 * Admin tab (Figma `Button/UI/Desktop/Tertiary`): the active tab is black with a
 * black underline; inactive tabs are the brand purple with no underline. The
 * full-width divider that separates the section header from the master-detail
 * body lives on the row wrapper (below), not on the tab itself.
 */
const navLinkClass = ({ isActive }) =>
  cn(
    "border-b-2 pb-1 px-6 text-caption font-semibold text-sm transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-neutral-900"
      : "border-transparent text-primary hover:text-primary/80"
  )

/**
 * Admin shell (`OCELIA/AdminView/*` frames): top banner (brand + account), then
 * the "ADMINISTRATION" title + subtitle, then the `Instructors / Courses` tab
 * row with the section's primary action on the right (Add instructor / Add
 * course) and a full-width divider below it, then the master-detail `Outlet`.
 * Body content sits in the frame's 112px page gutter (lg:px-28) so the title,
 * tabs, and list share the same left edge; the banner stays full-bleed.
 */
export default function AdminLayout() {
  const { pathname } = useLocation()
  const inCourses = pathname.startsWith("/admin/courses")

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader userRole="admin" />

      <div className="mx-auto w-full max-w-7xl px-6 pt-6 text-left">
        <h1 className="text-h2 font-normal uppercase text-foreground">Administration</h1>
        <p className="mt-4 text-body text-muted-foreground">
          Add and remove instructors, manage access, and create or duplicate new courses.
        </p>
      </div>

      <div className="mt-6 border-b border-border">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 pb-8">
          <nav className="flex items-center gap-6" aria-label="Admin navigation">
            <NavLink to="/admin/instructors" className={navLinkClass}>
              Instructors
            </NavLink>
            <NavLink to="/admin/courses" className={navLinkClass}>
              Courses
            </NavLink>
          </nav>
          {inCourses ? (
            // Figma `1035:6492`: two `Secondary with Icon` buttons in a
            // right-aligned 8px group — Duplicate course (left) + Add course.
            <div className="flex items-center justify-end gap-2">
              <Button asChild variant="outline" size="sm" className="h-7 gap-4 rounded-sm px-6">
                <Link to="/admin/courses/duplicate">
                  Duplicate course <Icon icon={MdContentCopy} size={20} />
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="h-7 gap-4 rounded-sm px-6">
                <Link to="/admin/courses/new">
                  Add course <Icon icon={MdAdd} size={20} />
                </Link>
              </Button>
            </div>
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
