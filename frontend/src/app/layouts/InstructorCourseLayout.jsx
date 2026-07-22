import { useState } from "react"
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom"
import { MdContentCopy } from "react-icons/md"
import { toast } from "react-toastify"
import { cn } from "@/lib/utils"
import {
  useInstructorCourses,
  useCoursePrompt,
  useAccessCode,
  useUpdateInstructorCourseAccess,
  useDeleteInstructorCourse,
} from "@/services/queries"
import { Toggle } from "@/components/ui/toggle"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
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
 * Right detail pane of the instructor course workspace (`SplitLayout` detail).
 * Renders the course header (code + Active/Inactive toggle + name + term/section
 * + access code + Delete course), the five section sub-tabs (with a conflict dot
 * on Settings when the stored prompt has unresolved conflicts), and the active
 * tab via `<Outlet>`. Matches Figma 365:2504. Course meta is derived from the
 * instructor course list (find-by-courseId); resilient to loading/error.
 *
 * The Active toggle + Delete course use the B7 instructor routes
 * (updateCourseAccess / delete_course, server-side ownership-checked). Edits
 * persist immediately (save-only, per decision — no Undo/Save footer).
 * `term`/`section` render only if present on the course record (no schema columns
 * today).
 */
export default function InstructorCourseLayout() {
  const { courseId } = useParams()
  const navigate = useNavigate()
  const { data: courses = [] } = useInstructorCourses()
  const { data: prompt } = useCoursePrompt(courseId)
  const { data: accessCode } = useAccessCode(courseId)
  const updateAccess = useUpdateInstructorCourseAccess(courseId)
  const deleteCourse = useDeleteInstructorCourse(courseId)
  const [deleteOpen, setDeleteOpen] = useState(false)

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

  const handleDelete = () => {
    deleteCourse.mutate(undefined, {
      onSuccess: () => {
        setDeleteOpen(false)
        toast.success("Course deleted")
        navigate("/instructor/courses")
      },
      onError: () => toast.error("Couldn't delete the course."),
    })
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-border pb-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl leading-normal font-semibold text-neutral-900">{code}</h1>
          {course && (
            <div className="flex shrink-0 items-center gap-2 text-caption">
              <span className={active ? "text-muted-foreground" : "font-semibold text-foreground"}>
                Inactive
              </span>
              <Toggle
                checked={active}
                onCheckedChange={(v) => updateAccess.mutate(v)}
                disabled={updateAccess.isPending}
                aria-label="Course active"
              />
              <span className={active ? "font-semibold text-foreground" : "text-muted-foreground"}>
                Active
              </span>
            </div>
          )}
        </div>

        {/* Row 2 (Figma 365:2504): course name (left) + access code aligned on the
            same line (right) — not dropped to the term row, which left a gap above it. */}
        <div className="flex items-center gap-4 mb-4">
          {course?.course_name && (
            <p className="min-w-0 text-body text-foreground">{course.course_name}</p>
          )}
          {course && accessCode && (
            <div className="ml-auto flex shrink-0 items-center gap-2 text-lg mb-2">
              <span>
                Access Code: <span className="text-foreground">{accessCode}</span>
              </span>
              <button
                type="button"
                onClick={copyAccessCode}
                aria-label="Copy access code"
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={MdContentCopy} size={16} />
              </button>
            </div>
          )}
        </div>

        {/* Row 3: term | section (left) + Delete course (right). */}
        <div className="mt-1 flex items-center gap-4">
          {/* term | section — forward-compatible (no schema columns today). */}
          {course?.term && (
            <div className="text-caption text-foreground">
              <span>
                {course.term}
                {course.section ? ` | Section ${course.section}` : ""}
              </span>
            </div>
          )}
          {course && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="ml-auto text-caption text-destructive leading-7 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Delete course
            </button>
          )}
        </div>
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

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete course?"
        description={`Delete "${code}" and all its concepts, modules, files, and student data? This can't be undone.`}
        confirmLabel="Delete course"
        variant="danger"
        loading={deleteCourse.isPending}
        onConfirm={handleDelete}
      />
    </div>
  )
}
