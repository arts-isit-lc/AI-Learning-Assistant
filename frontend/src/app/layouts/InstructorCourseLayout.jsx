import { NavLink, Outlet, useParams } from "react-router-dom"
import { MdContentCopy } from "react-icons/md"
import { toast } from "react-toastify"
import { cn } from "@/lib/utils"
import { useInstructorCourses, useCoursePrompt, useAccessCode } from "@/services/queries"
import { Badge } from "@/components/ui/badge"
import { Icon } from "@/components/ui/icon"

// Sub-tabs of the instructor course workspace (audit §7). Paths are relative to
// /instructor/courses/:courseId.
const TABS = [
  { to: "configuration", label: "Configuration" },
  { to: "insights", label: "Insights" },
  { to: "chat-history", label: "Chat history" },
  { to: "settings", label: "Settings" },
  { to: "students", label: "Students" },
]

const tabClass = ({ isActive }) =>
  cn(
    "-mb-px border-b-2 px-1 pb-2 text-caption font-semibold transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-primary"
      : "border-transparent text-muted-foreground hover:text-foreground"
  )

/**
 * Right detail pane of the instructor course workspace (`SplitLayout` detail —
 * the persistent course list is the left pane). Renders the course header
 * (code + status + title), the five section sub-tabs (with a conflict dot on
 * Settings when the stored prompt has unresolved conflicts), and the active tab
 * via `<Outlet>`. Course meta is derived from the instructor course list
 * (find-by-courseId); resilient to loading/error — never blocks the tabs.
 *
 * NOTE (Phase 2 fidelity): the Active/Inactive toggle, Access Code line, and the
 * Delete course · Undo · Save changes footer from the frame are deferred — they
 * need course-update mutations + cross-tab save coordination that don't exist
 * yet. Status shows read-only for now.
 */
export default function InstructorCourseLayout() {
  const { courseId } = useParams()
  const { data: courses = [] } = useInstructorCourses()
  const { data: prompt } = useCoursePrompt(courseId)

  const { data: accessCode } = useAccessCode(courseId)

  const course = courses.find((c) => c.course_id === courseId)
  const dept = course ? String(course.course_department ?? "").toUpperCase() : ""
  const code = course ? `${dept} ${course.course_number ?? ""}`.trim() : "Course"
  const active = course ? course.course_student_access !== false : true
  const hasConflict = Boolean(prompt?.conflict_metadata?.has_conflicts)

  const copyAccessCode = () => {
    if (!accessCode) return
    navigator.clipboard?.writeText(accessCode)
    toast.success("Access code copied")
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-border pb-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-h2 font-semibold text-foreground">{code}</h1>
          {course && (
            <Badge variant={active ? "success" : "secondary"}>{active ? "Active" : "Inactive"}</Badge>
          )}
        </div>
        {course?.course_name && (
          <p className="mt-1 text-body text-muted-foreground">{course.course_name}</p>
        )}
        {course && accessCode && (
          <div className="mt-2 flex items-center gap-2 text-caption text-muted-foreground">
            <span>
              Access Code: <span className="font-semibold text-foreground">{accessCode}</span>
            </span>
            <button
              type="button"
              onClick={copyAccessCode}
              aria-label="Copy access code"
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={MdContentCopy} size={16} />
            </button>
          </div>
        )}
      </div>

      <nav
        className="mt-4 flex gap-6 overflow-x-auto border-b border-border"
        aria-label="Course sections"
      >
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={tabClass}>
            <span className="inline-flex items-center gap-1.5">
              {tab.label}
              {tab.to === "settings" && hasConflict && (
                <span
                  role="status"
                  aria-label="Unresolved prompt conflict"
                  className="h-2 w-2 rounded-full bg-destructive"
                />
              )}
            </span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-6">
        <Outlet />
      </div>
    </div>
  )
}
