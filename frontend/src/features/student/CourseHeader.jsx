import { Link } from "react-router"
import { MdChevronLeft, MdExpandMore, MdExpandLess } from "react-icons/md"
import { titleCase } from "@/utils/formatters"
import { Icon } from "@/components/ui/icon"
import { Collapse } from "@/components/ui/collapse"
import { Skeleton } from "@/components/ui/skeleton"

/** "‹ COURSES" back link (purple, uppercase). */
function CoursesBackLink() {
  return (
    <Link
      to="/courses"
      className="inline-flex items-center gap-2 text-base leading-7 uppercase underline text-primary hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Icon icon={MdChevronLeft} size={24} />
      Courses
    </Link>
  )
}

/** Reduce / Expand toggle for the collapsible header (module chat). */
function CollapseToggle({ collapsed, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-2 text-base leading-7 text-primary underline hover:no-underline"
    >
      {collapsed ? "Expand" : "Reduce"}
      <Icon icon={collapsed ? MdExpandMore : MdExpandLess} size={24} />
    </button>
  )
}

/** Thin vertical separator between meta items (matches the Figma pipe). */
function MetaPipe() {
  return (
    <span className="mx-3 text-border" aria-hidden="true">
      |
    </span>
  )
}

/** "First Last" for an instructor; empty when the invited user hasn't signed up
 *  yet (names still null) — the header then shows the email alone. */
function instructorName(instructor) {
  return [instructor?.first_name, instructor?.last_name].filter(Boolean).join(" ").trim()
}

/**
 * Shared course header (Figma 143:1427): "‹ COURSES" back link, then the course
 * code + name with the instructor list beneath it on the left, and term/section
 * in the top-right. Used by CourseView and StudentChat. On the chat page it's
 * `collapsible`: `collapsed` shows a single line (‹ COURSES + Expand) to free up
 * chat room.
 *
 * Instructors, term, and section come from GET /student/course (and
 * /instructor/student_course); each block renders only when present. `section`
 * is a bare token ("101"), so it's shown as "Section 101". The frame's Syllabus
 * button is intentionally omitted (no syllabus feature).
 *
 * While `loading`, the course-identity lines (code / name / instructors) render
 * as skeletons instead of a placeholder "Course" title, so the header resolves
 * in step with the page body rather than flashing stale chrome.
 *
 * @param {{ course?: object, loading?: boolean, collapsible?: boolean, collapsed?: boolean, onToggleCollapse?: () => void }} props
 */
export function CourseHeader({ course, loading = false, collapsible = false, collapsed = false, onToggleCollapse }) {
  const title = course
    ? `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
    : "Course"

  const instructors = Array.isArray(course?.instructors) ? course.instructors : []
  const hasTermMeta = Boolean(course?.term || course?.section)

  return (
    <div className="flex flex-col mb-6">
      {/* Top row: back link (+ compact code when reduced) + Reduce/Expand toggle. */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <CoursesBackLink />
          {collapsed &&
            (loading ? (
              <Skeleton className="h-6 w-32" />
            ) : (
              // Reduced one-liner (Figma 209:4781): the code stays beside the back
              // link. It mirrors the h1 below — hidden from assistive tech while
              // reduced — so the course is still announced exactly once.
              <span className="text-h4 font-semibold text-neutral-900">{title}</span>
            ))}
        </div>
        {collapsible && <CollapseToggle collapsed={collapsed} onToggle={onToggleCollapse} />}
      </div>

      {/* Course details (Figma 143:1427): code + name + instructor list on the
          left, term/section top-right. Reduce/Expand slides this open/closed via
          the shared Collapse primitive (same motion as every accordion). */}
      <Collapse open={!collapsed}>
        {loading ? (
          // Course identity is still resolving — skeleton the code/name/instructor
          // lines (role=status announces the wait) rather than showing a stale
          // "Course" title that pops to the real value.
          <div role="status" aria-label="Loading course" className="flex flex-col gap-6 pb-2 pt-6">
            <div className="flex flex-col gap-4">
              <Skeleton className="h-9 w-48" />
              <Skeleton className="h-6 w-72" />
            </div>
            <Skeleton className="h-5 w-56" />
          </div>
        ) : (
        <div className="flex items-start justify-between gap-6 pb-2 pt-6">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <h1 className="text-4xl leading-7 font-semibold text-neutral-900">{title}</h1>
              {course?.course_name && (
                <p className="text-body text-foreground">{titleCase(course.course_name)}</p>
              )}
            </div>

            {instructors.length > 0 && (
              <div className="flex flex-wrap items-center gap-y-1 text-base leading-7">
                {instructors.map((instructor, i) => {
                  const name = instructorName(instructor)
                  return (
                    <span key={instructor.user_email ?? i} className="flex items-center">
                      {i > 0 && <MetaPipe />}
                      <span className="flex items-center gap-2.5">
                        {name && <span className="text-foreground">{name}</span>}
                        {instructor.user_email && (
                          <a
                            href={`mailto:${instructor.user_email}`}
                            className="text-primary underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          >
                            {instructor.user_email}
                          </a>
                        )}
                      </span>
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          {hasTermMeta && (
            <div className="flex shrink-0 items-center whitespace-nowrap text-base leading-7 text-foreground">
              {course?.term && <span>{course.term}</span>}
              {course?.term && course?.section && <MetaPipe />}
              {course?.section && <span>Section {course.section}</span>}
            </div>
          )}
        </div>
        )}
      </Collapse>
    </div>
  )
}
