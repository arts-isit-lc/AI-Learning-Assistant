import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { MdAdd, MdSchool } from "react-icons/md"
import { useCourses, useCourseProgressSummary } from "@/services/queries"
import { useAuth } from "@/context/AuthContext"
import { PageContainer } from "@/components/composed/PageContainer"
import { StudentCourseCard } from "./StudentCourseCard"
import { EmptyState } from "@/components/composed/EmptyState"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { JoinCourseDialog } from "./JoinCourseDialog"

const GRID = "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"

/** Student home — course grid + join-by-code. Route: /courses. Matches the
 *  Figma frame 143:1171: uppercase "COURSES" heading, a purple "Join course"
 *  CTA (with +) top-right, and a 3-column Card/Course grid. Per-course progress
 *  comes from one batched `student/progress_summary` query (not per card). */
export function StudentHome() {
  const navigate = useNavigate()
  const { isInstructorAsStudent } = useAuth()
  const { data: courses = [], isLoading, isError } = useCourses({
    asInstructor: isInstructorAsStudent,
  })
  const { data: progressSummary = [], isLoading: progressLoading } = useCourseProgressSummary({
    asInstructor: isInstructorAsStudent,
  })
  const progressByCourse = useMemo(
    () => new Map((progressSummary || []).map((p) => [p.course_id, p])),
    [progressSummary]
  )
  const [joinOpen, setJoinOpen] = useState(false)

  return (
    <PageContainer>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-h2 font-semibold uppercase text-neutral-900">Courses</h1>
        <Button className="gap-2" onClick={() => setJoinOpen(true)}>
          Join course
          <Icon icon={MdAdd} size={18} />
        </Button>
      </div>

      <div className="mt-6">
        {isLoading ? (
          <div className={GRID}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 w-full" />
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
              <StudentCourseCard
                key={course.course_id}
                course={course}
                progress={progressByCourse.get(course.course_id) ?? null}
                loading={!isInstructorAsStudent && progressLoading}
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
