import { useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import {
  useAdminInstructors,
  useAdminCourses,
  useInstructorAssignedCourses,
  useSetInstructorCourses,
  useLowerInstructor,
} from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { instructorLabel } from "./InstructorList"
import { ProfileHeader } from "@/components/composed/ProfileHeader"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

function courseLabel(course) {
  return `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""} — ${course.course_name ?? ""}`
}

/**
 * Instructor detail (right pane of /admin/instructors). Assign the instructor to
 * courses via a checklist (Save persists the whole set via delete-all-then-
 * re-enroll), or remove instructor access (demote). Route param is the encoded
 * email; the record + name come from the already-loaded instructor list.
 */
export function InstructorDetail() {
  const { instructorId } = useParams()
  const navigate = useNavigate()
  const email = decodeURIComponent(instructorId)

  const { data: instructors = [] } = useAdminInstructors()
  const { data: assigned = [], isLoading } = useInstructorAssignedCourses(email)
  const { data: allCourses = [] } = useAdminCourses()
  const setCourses = useSetInstructorCourses(email)
  const lower = useLowerInstructor()

  const instructor = instructors.find((i) => i.user_email === email)
  const named = Boolean(instructor?.first_name && instructor?.last_name)
  const [selected, setSelected] = useState(() => new Set())
  const [removeOpen, setRemoveOpen] = useState(false)
  const seededRef = useRef(false)

  useEffect(() => {
    if (!isLoading && !seededRef.current) {
      seededRef.current = true
      setSelected(new Set(assigned.map((c) => c.course_id)))
    }
  }, [isLoading, assigned])

  const toggle = (courseId) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(courseId)) next.delete(courseId)
      else next.add(courseId)
      return next
    })

  const handleSave = () =>
    setCourses.mutate([...selected], { onSuccess: () => toast.success("Assignments updated") })

  return (
    <div className="flex flex-col gap-6">
      <ProfileHeader
        user={{ name: instructor ? instructorLabel(instructor) : titleCase(email), email }}
        subtitle={named ? email : "Invited — awaiting signup"}
        actions={
          <Button variant="danger" onClick={() => setRemoveOpen(true)} disabled={lower.isPending}>
            Remove instructor
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Assigned courses</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : allCourses.length === 0 ? (
            <p className="text-caption text-muted-foreground">No courses exist yet.</p>
          ) : (
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">Assigned courses</legend>
              {allCourses.map((course) => (
                <label key={course.course_id} className="flex items-center gap-2 text-caption">
                  <input
                    type="checkbox"
                    checked={selected.has(course.course_id)}
                    onChange={() => toggle(course.course_id)}
                  />
                  <span className="truncate">{courseLabel(course)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <Button onClick={handleSave} loading={setCourses.isPending}>
              Save assignments
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove instructor?"
        description={`Remove instructor access for ${email}? Their instructor role and course assignments are removed — their account and any student data are unaffected.`}
        confirmLabel="Remove instructor"
        variant="danger"
        loading={lower.isPending}
        onConfirm={() =>
          lower.mutate(email, {
            onSuccess: () => {
              setRemoveOpen(false)
              toast.success("Instructor removed")
              navigate("/admin/instructors")
            },
          })
        }
      />
    </div>
  )
}
