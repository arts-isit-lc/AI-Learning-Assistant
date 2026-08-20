import { titleCase } from "@/utils/formatters"
import { CourseCard } from "@/components/composed/CourseCard"

/**
 * Student-home course tile: maps a course record + its progress-summary entry
 * onto the presentational `CourseCard`. Progress is supplied by the parent from
 * one batched `student/progress_summary` query — not fetched per card.
 *
 * @param {{
 *   course: object,
 *   progress?: { percent: number, completed: number, total: number } | null,
 *   loading?: boolean,
 *   onOpen?: () => void,
 * }} props
 */
export function StudentCourseCard({ course, progress = null, loading = false, onOpen }) {
  const dept = String(course.course_department ?? "").toUpperCase()
  const base = `${dept} ${course.course_number ?? ""}`.trim()
  // Section is a bare token ("101"); the Figma card shows it in parens beside
  // the code (`GEOG 412 (101)`) as part of the same semibold line.
  const code = course.section ? `${base} (${course.section})` : base
  const name = titleCase(course.course_name ?? "Untitled course")
  const term = course.term || undefined

  const hasProgress = progress && progress.total > 0
  const status = hasProgress ? (progress.percent === 100 ? "completed" : "in_progress") : undefined

  return (
    <CourseCard
      code={code}
      name={name}
      term={term}
      progress={hasProgress ? progress : null}
      status={status}
      loading={loading}
      onOpen={onOpen}
    />
  )
}
