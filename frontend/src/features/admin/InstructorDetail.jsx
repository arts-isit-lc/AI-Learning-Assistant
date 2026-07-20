import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdAdd } from "react-icons/md"
import {
  useAdminInstructors,
  useAdminCourses,
  useInstructorAssignedCourses,
  useUpdateInstructorAccess,
  useEnrollInstructor,
  useUnenrollInstructor,
  useLowerInstructor,
} from "@/services/queries"
import { cn } from "@/lib/utils"
import { titleCase } from "@/utils/formatters"
import { instructorLabel } from "./InstructorList"
import { ProfileHeader } from "@/components/composed/ProfileHeader"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

/** "DEPT NUMBER — Name" label for a course. */
function courseLabel(course) {
  const code = `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
  return course.course_name ? `${code} — ${course.course_name}` : code
}

/** Off/On access toggle with labels (mockup: "Off [switch] On"). */
function AccessToggle({ checked, onCheckedChange, label }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className={cn("text-caption", checked ? "text-muted-foreground" : "font-semibold text-foreground")}>
        Off
      </span>
      <Toggle checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      <span className={cn("text-caption", checked ? "font-semibold text-foreground" : "text-muted-foreground")}>
        On
      </span>
    </div>
  )
}

/**
 * Instructor detail (right pane of /admin/instructors). Matches the OCELIA frame:
 * a profile header, the instructor's assigned courses each with a Remove link and
 * a per-course OCELIA access toggle (backend track B4), and a Remove-instructor
 * footer (demotes via lower_instructor). Assignment Add/Remove use single
 * enroll/unenroll so other courses' access flags are untouched; the access
 * toggles are optimistic (override then reconcile on refetch / rollback on error).
 */
export function InstructorDetail() {
  const { instructorId } = useParams()
  const navigate = useNavigate()
  const email = decodeURIComponent(instructorId)

  const { data: instructors = [] } = useAdminInstructors()
  const { data: assigned = [], isLoading } = useInstructorAssignedCourses(email)
  const { data: allCourses = [] } = useAdminCourses()
  const updateInstructorAccess = useUpdateInstructorAccess()
  const enroll = useEnrollInstructor()
  const unenroll = useUnenrollInstructor()
  const lower = useLowerInstructor()

  const instructor = instructors.find((i) => i.user_email === email)
  const named = Boolean(instructor?.first_name && instructor?.last_name)

  const [accessOverrides, setAccessOverrides] = useState({})
  const [addOpen, setAddOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)

  // Drop each per-course override once the refetch reflects it.
  useEffect(() => {
    setAccessOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev
      const next = { ...prev }
      let changed = false
      for (const course of assigned) {
        if (course.course_id in next && (course.access_enabled !== false) === next[course.course_id]) {
          delete next[course.course_id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [assigned])

  const unassigned = useMemo(() => {
    const assignedIds = new Set(assigned.map((c) => c.course_id))
    return allCourses.filter((c) => !assignedIds.has(c.course_id))
  }, [assigned, allCourses])

  const accessOn = (course) => accessOverrides[course.course_id] ?? (course.access_enabled !== false)

  const handleToggleAccess = (courseId, value) => {
    setAccessOverrides((o) => ({ ...o, [courseId]: value }))
    updateInstructorAccess.mutate(
      { courseId, instructorEmail: email, access: value },
      {
        onSuccess: () => toast.success(value ? "Access enabled" : "Access disabled"),
        onError: () =>
          setAccessOverrides((o) => {
            const next = { ...o }
            delete next[courseId]
            return next
          }),
      }
    )
  }

  const handleAdd = (courseId) => {
    enroll.mutate(
      { courseId, instructorEmail: email },
      {
        onSuccess: () => {
          setAddOpen(false)
          toast.success("Course assigned")
        },
      }
    )
  }

  const handleRemove = (courseId) => {
    unenroll.mutate(
      { courseId, instructorEmail: email },
      { onSuccess: () => toast.success("Course removed") }
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <ProfileHeader
        user={{ name: instructor ? instructorLabel(instructor) : titleCase(email), email }}
        subtitle={named ? email : "Invited — awaiting signup"}
      />

      {/* Assigned courses: each with Remove + per-course OCELIA access toggle. */}
      <div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1">
            <h2 className="text-caption font-semibold text-foreground">Assigned courses</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setAddOpen(true)}
              aria-label="Assign course"
            >
              <Icon icon={MdAdd} size={18} />
            </Button>
          </div>
          <span className="text-caption font-semibold text-foreground">OCELIA access</span>
        </div>

        <div className="mt-2 flex flex-col">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : assigned.length === 0 ? (
            <p className="py-3 text-caption text-muted-foreground">No courses assigned yet.</p>
          ) : (
            assigned.map((course) => (
              <div
                key={course.course_id}
                className="flex items-center justify-between gap-4 border-b border-border py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-caption font-medium text-foreground">{courseLabel(course)}</p>
                  <button
                    type="button"
                    onClick={() => handleRemove(course.course_id)}
                    className="text-caption text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove
                  </button>
                </div>
                <AccessToggle
                  checked={accessOn(course)}
                  onCheckedChange={(v) => handleToggleAccess(course.course_id, v)}
                  label={`OCELIA access for ${courseLabel(course)}`}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer: Remove instructor (demote). */}
      <div className="flex items-center gap-4 border-t border-border pt-4">
        <Button
          variant="link"
          className="text-destructive"
          onClick={() => setRemoveOpen(true)}
          disabled={lower.isPending}
        >
          Remove instructor
        </Button>
      </div>

      {/* Assign-course picker. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a course</DialogTitle>
            <DialogDescription>Give this instructor access to a course.</DialogDescription>
          </DialogHeader>
          <div className="my-2 flex max-h-72 flex-col overflow-y-auto">
            {unassigned.length === 0 ? (
              <p className="py-3 text-caption text-muted-foreground">
                This instructor is already assigned to every course.
              </p>
            ) : (
              unassigned.map((course) => (
                <button
                  key={course.course_id}
                  type="button"
                  onClick={() => handleAdd(course.course_id)}
                  disabled={enroll.isPending}
                  className="border-b border-border px-1 py-3 text-left text-caption font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
                >
                  <span className="block truncate">{courseLabel(course)}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

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
