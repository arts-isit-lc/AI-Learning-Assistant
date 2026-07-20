import { Link, NavLink } from "react-router-dom"
import { MdLogout } from "react-icons/md"
import { useAuth } from "@/context/AuthContext"
import { Icon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import ubcLogo from "@/assets/ubc-logo.svg"

const NAV_ITEMS = {
  student: [],
  instructor: [
    { to: "/instructor/courses", label: "Courses" },
    { to: "/instructor/analytics", label: "Global Analytics" },
    { to: "/instructor/chats", label: "Global Chats" },
  ],
  admin: [
    { to: "/admin/instructors", label: "Instructors" },
    { to: "/admin/courses", label: "Courses" },
  ],
}

const navLinkClass = ({ isActive }) =>
  cn(
    "rounded-md px-3 py-2 text-caption font-semibold transition-colors duration-fast",
    "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive ? "bg-accent text-primary" : "text-muted-foreground"
  )

const controlClass =
  "rounded-md px-3 py-1.5 text-caption font-semibold text-foreground transition-colors duration-fast hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

/**
 * Top-nav application header per role — the OCELIA nav shell (replaces the
 * retired left `AppSidebar`). This is the minimal Phase-2 shell; Phase 4 refines
 * it to full mockup fidelity + the complete interactive-state set.
 *
 * @param {{ role: "student"|"instructor"|"admin" }} props
 */
export function AppHeader({ role }) {
  const { signOut, isInstructorAsStudent, setIsInstructorAsStudent } = useAuth()
  const items = NAV_ITEMS[role] ?? []

  return (
    <header className="sticky top-0 z-sticky border-b border-border bg-background">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <img
              src={ubcLogo}
              alt="University of British Columbia"
              className="h-10 w-auto shrink-0"
            />
            <span className="text-h4 font-semibold text-navy">OCELIA</span>
          </Link>
          {items.length > 0 && (
            <nav className="flex items-center gap-1" aria-label={`${role} navigation`}>
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} className={navLinkClass}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          )}
        </div>

        <div className="flex items-center gap-3">
          {role === "instructor" && (
            <button
              type="button"
              onClick={() => setIsInstructorAsStudent((v) => !v)}
              className={cn(controlClass, "border border-border")}
            >
              {isInstructorAsStudent ? "Exit student view" : "View as student"}
            </button>
          )}
          <button
            type="button"
            onClick={signOut}
            className={cn(controlClass, "flex items-center gap-2")}
          >
            <Icon icon={MdLogout} size={18} />
            Sign out
          </button>
        </div>
      </div>
    </header>
  )
}
