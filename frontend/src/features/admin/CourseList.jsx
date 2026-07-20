import { useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { MdAdd } from "react-icons/md"
import { useAdminCourses } from "@/services/queries"
import { Searchbar } from "@/components/composed/Searchbar"
import { ListRow } from "@/components/composed/ListRow"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

/** "DEPT NUMBER" code label for a course. */
export function courseCode(course) {
  return `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
}

/**
 * Course management master pane (SplitLayout `list`). Search + navigate to a
 * course detail; "New course" opens the create form.
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-h4 font-semibold text-navy">Courses</h1>
        <Button size="sm" onClick={() => navigate("/admin/courses/new")}>
          <Icon icon={MdAdd} size={18} /> New course
        </Button>
      </div>
      <Searchbar value={query} onChange={setQuery} placeholder="Search courses" />

      <div className="flex max-h-[calc(100vh-16rem)] flex-col gap-2 overflow-y-auto">
        {isLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)
        ) : filtered.length === 0 ? (
          <p className="px-1 text-caption text-muted-foreground">No courses found.</p>
        ) : (
          filtered.map((course) => (
            <ListRow
              key={course.course_id}
              selected={courseId === course.course_id}
              onClick={() => navigate(`/admin/courses/${course.course_id}`)}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-caption font-semibold text-foreground group-aria-[current=true]:text-primary-foreground">
                  {courseCode(course)}
                </span>
                <span className="truncate text-caption text-muted-foreground group-aria-[current=true]:text-primary-foreground/80">
                  {course.course_name}
                </span>
              </div>
              {course.course_student_access === false && <Badge variant="secondary">Inactive</Badge>}
            </ListRow>
          ))
        )}
      </div>
    </div>
  )
}
