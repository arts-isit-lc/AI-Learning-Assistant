import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { useInstructorCourses } from "@/services/queries"
import { Searchbar } from "@/components/composed/Searchbar"
import { ListRow } from "@/components/composed/ListRow"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

/** "DEPT NUMBER" code label for a course. */
export function courseCode(course) {
  return `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
}

/**
 * Instructor course list — the persistent master pane of the instructor course
 * workspace (`SplitLayout` `list`). Search + select a course to open its detail
 * on the right. Mirrors the admin `CourseList` pattern; navigates to
 * /instructor/courses/:courseId.
 */
export function InstructorCourseList() {
  const navigate = useNavigate()
  const { courseId } = useParams()
  const { data: courses = [], isLoading } = useInstructorCourses()
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return courses
    return courses.filter((c) => `${courseCode(c)} ${c.course_name}`.toLowerCase().includes(q))
  }, [courses, query])

  return (
    <div className="flex flex-col gap-3">
      <Searchbar value={query} onChange={setQuery} placeholder="Search" />

      <div className="flex max-h-[calc(100vh-16rem)] flex-col gap-2 overflow-y-auto">
        {isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)
        ) : filtered.length === 0 ? (
          <p className="px-1 text-caption text-muted-foreground">No courses found.</p>
        ) : (
          filtered.map((course) => {
            const active = course.course_student_access !== false
            return (
              <ListRow
                key={course.course_id}
                selected={courseId === course.course_id}
                onClick={() => navigate(`/instructor/courses/${course.course_id}`)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-caption font-semibold text-foreground">
                      {courseCode(course)}
                    </span>
                    <Badge variant={active ? "success" : "secondary"}>
                      {active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  {course.course_name && (
                    <span className="truncate text-caption text-muted-foreground">
                      {course.course_name}
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
