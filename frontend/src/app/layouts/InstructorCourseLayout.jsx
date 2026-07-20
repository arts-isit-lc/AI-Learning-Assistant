import { NavLink, Outlet, useParams } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useInstructorCourses, useCoursePrompt } from "@/services/queries"
import { Breadcrumb } from "@/components/composed/Breadcrumb"

// Sub-tabs of the instructor course workspace (audit §7). Paths are relative to
// /instructor/courses/:courseId.
const TABS = [
  { to: "configuration", label: "Configuration" },
  { to: "insights", label: "Insights" },
  { to: "chat-history", label: "Chat History" },
  { to: "settings", label: "Settings" },
  { to: "students", label: "Students" },
]

const tabClass = ({ isActive }) =>
  cn(
    "-mb-px border-b-2 px-4 py-2 text-caption font-semibold transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    isActive
      ? "border-primary text-primary"
      : "border-transparent text-muted-foreground hover:text-foreground"
  )

/**
 * Layout for the instructor's in-course area: a course header + breadcrumb and
 * the five sub-tabs, with the active tab rendered via `<Outlet>`. Course meta is
 * derived from the instructor course list (find-by-courseId); the Settings tab
 * shows a dot when there's an unresolved prompt conflict (from stored
 * `conflict_metadata`). Resilient to loading/error — never blocks the tabs.
 */
export default function InstructorCourseLayout() {
  const { courseId } = useParams()
  const { data: courses = [] } = useInstructorCourses()
  const { data: prompt } = useCoursePrompt(courseId)

  const course = courses.find((c) => c.course_id === courseId)
  const dept = course ? String(course.course_department ?? "").toUpperCase() : ""
  const code = course ? `${dept} ${course.course_number ?? ""}`.trim() : "Course"
  const hasConflict = Boolean(prompt?.conflict_metadata?.has_conflicts)

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <Breadcrumb
        items={[{ label: "Your courses", to: "/instructor/courses" }, { label: code }]}
        className="mb-4"
      />
      <div className="mb-4 border-b border-border pb-4">
        <p className="text-caption uppercase text-muted-foreground">Course</p>
        <h1 className="text-h4 font-semibold text-navy">
          {code}
          {course?.course_name ? ` — ${course.course_name}` : ""}
        </h1>
      </div>
      <nav
        className="mb-6 flex gap-1 overflow-x-auto border-b border-border"
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
      <Outlet />
    </div>
  )
}
