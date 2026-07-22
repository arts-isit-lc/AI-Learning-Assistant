import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useAdminCourses } from "@/services/queries"
import { Searchbar } from "@/components/composed/Searchbar"
import { ListRow } from "@/components/composed/ListRow"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

/** "DEPT NUMBER" code label for a course. */
export function courseCode(course) {
  return `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
}

/**
 * Course management master pane (SplitLayout `list`). Search + navigate to a
 * course detail. Each row is the course code + a status badge (right) over the
 * course name, flush and divider-separated, with the selected row filled (see
 * `ListRow`). The "Add course" action lives in the admin section header
 * (`AdminLayout`), not here.
 */
export function CourseList() {
  const navigate = useNavigate()
  const { courseId } = useParams()
  const { data: courses = [], isLoading } = useAdminCourses()
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return courses
    return courses.filter((c) => `${courseCode(c)} ${c.course_name}`.toLowerCase().includes(q))
  }, [courses, query])

  return (
    <div className="flex flex-col gap-4">
      <Searchbar
        value={query}
        onChange={setQuery}
        placeholder="Search courses"
        inputClassName="h-[50px]"
      />

      <div className="flex max-h-[calc(100vh-18rem)] flex-col overflow-y-auto">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-1 py-3 text-caption text-muted-foreground">No courses found.</p>
        ) : (
          filtered.map((course) => {
            const active = course.course_student_access !== false
            return (
              <ListRow
                key={course.course_id}
                selected={courseId === course.course_id}
                onClick={() => navigate(`/admin/courses/${course.course_id}`)}
                className="p-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-base leading-7 mb-1 font-semibold text-foreground group-aria-[current=true]:text-primary-foreground">
                      {courseCode(course)}
                    </span>
                    <Badge variant={active ? "success" : "secondary"} className="shrink-0 uppercase">
                      {active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  {course.course_name && (
                    <span className="truncate text-caption text-muted-foreground group-aria-[current=true]:text-primary-foreground/90">
                      {course.course_name}
                    </span>
                  )}
                  {/* term/section — forward-compatible (no schema columns today). */}
                  {course.term && (
                    <span className="truncate text-xs font-semibold text-foreground group-aria-[current=true]:text-primary-foreground/90">
                      {course.term}
                      {course.section ? ` (${course.section})` : ""}
                    </span>
                  )}
                </div>
              </ListRow>
            )
          })
        )}
      </div>
    </div>
  )
}
