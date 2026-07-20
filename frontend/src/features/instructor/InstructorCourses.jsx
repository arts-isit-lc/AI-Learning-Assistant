import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { MdSchool } from "react-icons/md"
import { useInstructorCourses } from "@/services/queries"
import { PageContainer } from "@/components/composed/PageContainer"
import { PageHeader } from "@/components/composed/PageHeader"
import { Searchbar } from "@/components/composed/Searchbar"
import { CourseCard } from "@/components/composed/CourseCard"
import { EmptyState } from "@/components/composed/EmptyState"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"

/**
 * Instructor home — the courses the instructor teaches. Route: /instructor/courses.
 * Read + navigate only; course creation/duplication is an admin action (Phase 7).
 * Cards stay clickable regardless of student-access status so an instructor can
 * always open a course to manage it.
 */
export function InstructorCourses() {
  const navigate = useNavigate()
  const { data: courses = [], isLoading, isError } = useInstructorCourses()
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return courses
    return courses.filter((c) =>
      `${c.course_department} ${c.course_number} ${c.course_name}`.toLowerCase().includes(q)
    )
  }, [courses, query])

  return (
    <PageContainer>
      <PageHeader
        title="Your courses"
        description="Select a course to manage its content, settings, and students."
      />

      <div className="mt-6 flex flex-col gap-4">
        {!isLoading && !isError && courses.length > 0 && (
          <Searchbar
            value={query}
            onChange={setQuery}
            placeholder="Search courses"
            className="max-w-sm"
          />
        )}

        {isLoading ? (
          <div className={GRID}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&rsquo;t load your courses</AlertTitle>
            <AlertDescription>Please refresh and try again.</AlertDescription>
          </Alert>
        ) : courses.length === 0 ? (
          <EmptyState
            icon={MdSchool}
            title="No courses yet"
            description="Courses you teach will appear here."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={MdSchool}
            title="No matches"
            description={`No courses match “${query}”.`}
          />
        ) : (
          <div className={GRID}>
            {filtered.map((course) => (
              <CourseCard
                key={course.course_id}
                course={course}
                onOpen={() => navigate(`/instructor/courses/${course.course_id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  )
}
