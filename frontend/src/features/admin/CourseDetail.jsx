import { useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import {
  useAdminCourses,
  useAdminInstructors,
  useCourseInstructors,
  useSetCourseInstructors,
  useUpdateCourseAccess,
  useDeleteCourse,
} from "@/services/queries"
import { instructorLabel } from "./InstructorList"
import { courseCode } from "./CourseList"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Toggle } from "@/components/ui/toggle"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Course detail (right pane of /admin/courses). Toggle student access
 * (persists immediately), assign instructors via a checklist (Save replaces the
 * set), view the access code, or delete the course. The record + access code
 * come from the already-loaded course list.
 */
export function CourseDetail() {
  const { courseId } = useParams()
  const navigate = useNavigate()

  const { data: courses = [] } = useAdminCourses()
  const { data: assigned = [], isLoading } = useCourseInstructors(courseId)
  const { data: allInstructors = [] } = useAdminInstructors()
  const setInstructors = useSetCourseInstructors(courseId)
  const updateAccess = useUpdateCourseAccess()
  const del = useDeleteCourse()

  const course = courses.find((c) => c.course_id === courseId)
  const [selected, setSelected] = useState(() => new Set())
  const [active, setActive] = useState(true)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const seededRef = useRef(false)
  const activeSeededRef = useRef(false)

  useEffect(() => {
    if (!isLoading && !seededRef.current) {
      seededRef.current = true
      setSelected(new Set(assigned.map((i) => i.user_email)))
    }
  }, [isLoading, assigned])

  useEffect(() => {
    if (course && !activeSeededRef.current) {
      activeSeededRef.current = true
      setActive(course.course_student_access !== false)
    }
  }, [course])

  const toggleInstructor = (email) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })

  const handleSaveInstructors = () =>
    setInstructors.mutate([...selected], { onSuccess: () => toast.success("Instructors updated") })

  const handleToggleActive = (value) => {
    setActive(value)
    updateAccess.mutate(
      { courseId, access: value },
      { onSuccess: () => toast.success(value ? "Course activated" : "Course deactivated") }
    )
  }

  const copyCode = async () => {
    if (!course?.course_access_code) return
    try {
      await navigator.clipboard.writeText(course.course_access_code)
      toast.success("Access code copied")
    } catch {
      toast.error("Couldn't copy the code")
    }
  }

  if (!course) {
    return <p className="text-caption text-muted-foreground">Loading course…</p>
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-h4 font-semibold text-navy">{courseCode(course)}</h1>
          <p className="text-caption text-muted-foreground">{course.course_name}</p>
        </div>
        <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={del.isPending}>
          Delete course
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-center gap-2">
            <Toggle id="course-active" checked={active} onCheckedChange={handleToggleActive} />
            <Label htmlFor="course-active">
              {active ? "Active — students can access" : "Inactive — students can't access"}
            </Label>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-caption text-muted-foreground">Access code</span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-caption text-navy">{course.course_access_code || "—"}</span>
              <Button size="sm" variant="outline" onClick={copyCode} disabled={!course.course_access_code}>
                Copy
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instructors</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : allInstructors.length === 0 ? (
            <p className="text-caption text-muted-foreground">No instructors exist yet.</p>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Instructors</legend>
              {allInstructors.map((instructor) => (
                <label key={instructor.user_email} className="flex items-center gap-2 text-caption">
                  <input
                    type="checkbox"
                    checked={selected.has(instructor.user_email)}
                    onChange={() => toggleInstructor(instructor.user_email)}
                  />
                  <span className="truncate">{instructorLabel(instructor)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <Button onClick={handleSaveInstructors} loading={setInstructors.isPending}>
              Save instructors
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete course?"
        description={`Delete "${course.course_name}"? This removes the course and all its content. This can't be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={del.isPending}
        onConfirm={() =>
          del.mutate(courseId, {
            onSuccess: () => {
              setDeleteOpen(false)
              toast.success("Course deleted")
              navigate("/admin/courses")
            },
          })
        }
      />
    </div>
  )
}
