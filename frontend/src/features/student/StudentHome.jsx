import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { MdSchool } from "react-icons/md"
import { useCourses } from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import { PageContainer } from "@/components/composed/PageContainer"
import { PageHeader } from "@/components/composed/PageHeader"
import { CourseCard } from "@/components/composed/CourseCard"
import { EmptyState } from "@/components/composed/EmptyState"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { JoinCourseDialog } from "./JoinCourseDialog"

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"

/** Student home — course grid + join-by-code. Route: /courses. */
export function StudentHome() {
  const navigate = useNavigate()
  const { isInstructorAsStudent } = useAuth()
  const { data: courses = [], isLoading, isError } = useCourses({
    asInstructor: isInstructorAsStudent,
  })
  const [joinOpen, setJoinOpen] = useState(false)

  return (
    <PageContainer>
      <PageHeader
        title="Courses"
        actions={<Button onClick={() => setJoinOpen(true)}>Join course</Button>}
      />

      <div className="mt-6">
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
            description="Join a course with the access code from your instructor."
            action={<Button onClick={() => setJoinOpen(true)}>Join course</Button>}
          />
        ) : (
          <div className={GRID}>
            {courses.map((course) => (
              <CourseCard
                key={course.course_id}
                course={course}
                onOpen={() => navigate(`/courses/${course.course_id}`)}
              />
            ))}
          </div>
        )}
      </div>

      <JoinCourseDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </PageContainer>
  )
}
