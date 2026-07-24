import { Link } from "react-router-dom"
import { MdChevronLeft, MdExpandMore, MdExpandLess } from "react-icons/md"
import { titleCase } from "@/utils/formatters"
import { Icon } from "@/components/ui/icon"

/** "‹ COURSES" back link (purple, uppercase). */
function CoursesBackLink() {
  return (
    <Link
      to="/courses"
      className="inline-flex items-center gap-2 text-base leading-7 mb-6 uppercase underline text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
      className="inline-flex items-center gap-1 text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {collapsed ? "Expand" : "Reduce"}
      <Icon icon={collapsed ? MdExpandMore : MdExpandLess} size={18} />
    </button>
  )
}

/**
 * Shared course header (Figma course + module-chat frames): "‹ COURSES" back
 * link, course code, name, and a meta line. Used by CourseView and StudentChat.
 * On the chat page it's `collapsible`: `collapsed` shows a single line
 * (‹ COURSES + code + Expand) to free up chat room.
 *
 * NOTE: the frame's meta line (term · instructor · email · section) and Syllabus
 * button are omitted — the `Courses` record carries none of that data and there's
 * no syllabus endpoint. The meta line renders forward-compatibly if those fields
 * ever appear on the record.
 *
 * @param {{ course?: object, collapsible?: boolean, collapsed?: boolean, onToggleCollapse?: () => void }} props
 */
export function CourseHeader({ course, collapsible = false, collapsed = false, onToggleCollapse }) {
  const title = course
    ? `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
    : "Course"

  const metaParts = []
  if (course?.term) metaParts.push({ text: course.term })
  if (course?.instructor_name) metaParts.push({ text: course.instructor_name })
  if (course?.instructor_email)
    metaParts.push({ text: course.instructor_email, href: `mailto:${course.instructor_email}` })
  if (course?.section) metaParts.push({ text: course.section })

  if (collapsed) {
    return (
      <div className="flex items-center justify-between gap-4 py-4">
        <div className="flex items-center gap-3">
          <CoursesBackLink />
        </div>
        {collapsible && <CollapseToggle collapsed onToggle={onToggleCollapse} />}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <CoursesBackLink />
        {collapsible && <CollapseToggle collapsed={false} onToggle={onToggleCollapse} />}
      </div>
      <h1 className="text-3xl leadgin-7 font-semibold text-neutral-900 mb-4">{title}</h1>
      {course?.course_name && <p className="text-body text-foreground mb-6">{titleCase(course.course_name)}</p>}
      {metaParts.length > 0 && (
        <div className="flex flex-wrap items-center text-base leading-7 text-foreground mb-8">
          {metaParts.map((p, i) => (
            <span key={i} className="flex items-center">
              {i > 0 && (
                <span className="mx-3 text-border" aria-hidden="true">
                  |
                </span>
              )}
              {p.href ? (
                <a href={p.href} className="text-primary hover:underline">
                  {p.text}
                </a>
              ) : (
                <span>{p.text}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
