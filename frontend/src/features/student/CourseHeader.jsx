import { Link } from "react-router-dom"
import { MdChevronLeft, MdExpandMore, MdExpandLess } from "react-icons/md"
import { titleCase } from "@/utils/formatters"
import { Icon } from "@/components/ui/icon"

/** "‹ COURSES" back link (purple, uppercase). */
function CoursesBackLink() {
  return (
    <Link
      to="/courses"
      className="inline-flex items-center gap-2 text-base leading-7 uppercase underline text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
      className="inline-flex items-center gap-2 text-base leading-7 text-primary underline"
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
 * @param {{ course?: object, collapsible?: boolean, collapsed?: boolean, onToggleCollapse?: () => void }} props
 */
export function CourseHeader({ course, collapsible = false, collapsed = false, onToggleCollapse }) {
  const title = course
    ? `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
    : "Course"

  const instructors = Array.isArray(course?.instructors) ? course.instructors : []
  const hasTermMeta = Boolean(course?.term || course?.section)

  if (collapsed) {
    return (
      <div className="flex justify-between items-start">
        <div className="flex items-center gap-3 mb-6">
          <CoursesBackLink />
          {/* Collapsed one-liner (Figma 209:4781): the course code stays beside
              the back link so the reduced header remains identifiable. */}
          <span className="text-h4 font-semibold text-neutral-900">{title}</span>
        </div>
        {collapsible && <CollapseToggle collapsed onToggle={onToggleCollapse} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-4 mb-6">
        <CoursesBackLink />
        {collapsible && <CollapseToggle collapsed={false} onToggle={onToggleCollapse} />}
      </div>

      {/* Course details (Figma 143:1427): code + name + instructor list on the
          left; term/section in the top-right. */}
      <div className="mb-8 flex items-start justify-between gap-6">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <h1 className="text-3xl leading-7 font-semibold text-neutral-900">{title}</h1>
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
    </div>
  )
}
