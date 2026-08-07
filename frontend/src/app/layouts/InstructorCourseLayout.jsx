import { useState } from "react"
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom"
import { toUserMessage } from "@/services/apiError"
import { cn } from "@/lib/utils"
import {
  useInstructorCourses,
  useCoursePrompt,
  useAccessCode,
  useUpdateInstructorCourseAccess,
  useDeleteInstructorCourse,
} from "@/services/queries"
import { Toggle } from "@/components/ui/toggle"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { CopyButton } from "@/components/composed/CopyButton"
import { Skeleton } from "@/components/ui/skeleton"

// Sub-tabs of the instructor course workspace (audit §7). Paths are relative to
// /instructor/courses/:courseId.
const TABS = [
  { to: "configuration", label: "Configuration" },
  { to: "insights", label: "Insights" },
  { to: "chat-history", label: "Chat history" },
  { to: "settings", label: "Settings" },
  { to: "students", label: "Students" },
]

// Mirrors the instructor top-nav tabs (InstructorTabBar `tabClass`, itself
// matched to the admin nav) EXACTLY, states included: inactive tabs are brand
// purple (text-primary) at a 4px radius with no fill; hover paints the
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
  const { data: courses = [], isLoading: coursesLoading } = useInstructorCourses()
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

  const handleDelete = () => {
    deleteCourse.mutate(undefined, {
      onSuccess: () => {
        setDeleteOpen(false)
        navigate("/instructor/courses")
      },
    })
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-border pb-6">
        {coursesLoading ? (
          // Course identity is still resolving — skeleton the code/name. The
          // section tabs + active tab (Outlet) below stay usable and load their
          // own content independently.
          <div role="status" aria-label="Loading course" className="flex flex-col gap-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-6 w-64" />
          </div>
        ) : (
          <>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl leading-normal font-semibold text-neutral-900">{code}</h1>
          {course && (
            <div className="flex shrink-0 items-center gap-2 text-caption">
              <span className={active ? "text-muted-foreground" : "font-semibold text-foreground"}>
                Off
              </span>
              <Toggle
                checked={active}
                onCheckedChange={(v) => updateAccess.mutate(v)}
                disabled={updateAccess.isPending}
                aria-label="Course active"
              />
              <span className={active ? "font-semibold text-foreground" : "text-muted-foreground"}>
                On
              </span>
            </div>
          )}
        </div>

        {updateAccess.isError && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{"Couldn't update the course — the change was reverted."}</AlertDescription>
          </Alert>
        )}

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
              <CopyButton value={accessCode} label="Copy access code" className="rounded-sm" />
            </div>
          )}
        </div>

        {/* Row 3: term | section (left) + Delete course (right). */}
        <div className="flex items-center gap-4">
          {/* term | section — forward-compatible (no schema columns today). */}
          {course?.term && (
            <div className="text-lg leading-7 text-foreground">
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
              className="ml-auto text-caption text-destructive leading-7 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Delete course
            </button>
          )}
        </div>
          </>
        )}
      </div>

      <nav
        className="mt-2.5 flex gap-2.5 overflow-x-auto"
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
        onOpenChange={(open) => {
          setDeleteOpen(open)
          if (!open) deleteCourse.reset?.()
        }}
        title="Delete course?"
        description={`Delete "${code}" and all its concepts, modules, files, and student data? This can't be undone.`}
        confirmLabel="Delete course"
        loading={deleteCourse.isPending}
        error={deleteCourse.isError ? toUserMessage(deleteCourse.error) : undefined}
        onConfirm={handleDelete}
      />
    </div>
  )
}
