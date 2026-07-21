import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdAdd, MdContentCopy } from "react-icons/md"
import {
  useAdminCourses,
  useAdminInstructors,
  useCourseInstructors,
  useUpdateCourseAccess,
  useUpdateInstructorAccess,
  useEnrollInstructor,
  useUnenrollInstructor,
  useDeleteCourse,
} from "@/services/queries"
import { cn } from "@/lib/utils"
import { instructorLabel } from "./InstructorList"
import { courseCode } from "./CourseList"
import { DuplicateCourseDialog } from "./DuplicateCourseDialog"
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
 * Course detail (right pane of /admin/courses). Matches the OCELIA frame: the
 * course header carries the Active/Inactive toggle (course-wide student access,
 * persisted immediately) and the access code; the instructor list shows each
 * assigned instructor with a Remove link and a per-instructor OCELIA access
 * toggle (backend track B4); the footer has Delete course + Duplicate (B2).
 *
 * Per-row toggles are optimistic (override the server value on click, then drop
 * the override once the refetch reflects it — or on error).
 */
export function CourseDetail() {
  const { courseId } = useParams()
  const navigate = useNavigate()

  const { data: courses = [] } = useAdminCourses()
  const { data: assigned = [], isLoading } = useCourseInstructors(courseId)
  const { data: allInstructors = [] } = useAdminInstructors()
  const updateCourseAccess = useUpdateCourseAccess()
  const updateInstructorAccess = useUpdateInstructorAccess()
  const enroll = useEnrollInstructor()
  const unenroll = useUnenrollInstructor()
  const del = useDeleteCourse()

  const course = courses.find((c) => c.course_id === courseId)

  const [activeOverride, setActiveOverride] = useState(null)
  const [accessOverrides, setAccessOverrides] = useState({})
  const [addOpen, setAddOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState(null)

  const active = activeOverride ?? (course?.course_student_access !== false)

  // Drop the course-active override once the refetched course reflects it.
  useEffect(() => {
    if (activeOverride != null && course && (course.course_student_access !== false) === activeOverride) {
      setActiveOverride(null)
    }
  }, [course, activeOverride])

  // Drop each per-instructor override once the refetch reflects it.
  useEffect(() => {
    setAccessOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev
      const next = { ...prev }
      let changed = false
      for (const inst of assigned) {
        if (inst.user_email in next && (inst.access_enabled !== false) === next[inst.user_email]) {
          delete next[inst.user_email]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [assigned])

  const unassigned = useMemo(() => {
    const assignedEmails = new Set(assigned.map((i) => i.user_email))
    return allInstructors.filter((i) => !assignedEmails.has(i.user_email))
  }, [assigned, allInstructors])

  const accessOn = (inst) => accessOverrides[inst.user_email] ?? (inst.access_enabled !== false)

  const handleToggleActive = (value) => {
    setActiveOverride(value)
    updateCourseAccess.mutate(
      { courseId, access: value },
      {
        onSuccess: () => toast.success(value ? "Course activated" : "Course deactivated"),
        onError: () => setActiveOverride(null),
      }
    )
  }

  const handleToggleAccess = (email, value) => {
    setAccessOverrides((o) => ({ ...o, [email]: value }))
    updateInstructorAccess.mutate(
      { courseId, instructorEmail: email, access: value },
      {
        onSuccess: () => toast.success(value ? "Access enabled" : "Access disabled"),
        onError: () =>
          setAccessOverrides((o) => {
            const next = { ...o }
            delete next[email]
            return next
          }),
      }
    )
  }

  const handleAdd = (email) => {
    enroll.mutate(
      { courseId, instructorEmail: email },
      {
        onSuccess: () => {
          setAddOpen(false)
          toast.success("Instructor added")
        },
      }
    )
  }

  const handleRemove = () => {
    unenroll.mutate(
      { courseId, instructorEmail: removeTarget.user_email },
      {
        onSuccess: () => {
          setRemoveTarget(null)
          toast.success("Instructor removed")
        },
      }
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
      {/* Header: code + Active/Inactive toggle, name, then term|section + access code
          (mirrors the instructor course-detail header). */}
      <div className="flex flex-col gap-1 border-b border-border pb-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-h2 font-semibold text-neutral-900">{courseCode(course)}</h1>
          <div className="flex shrink-0 items-center gap-2 text-caption">
            <span className={cn(active ? "text-muted-foreground" : "font-semibold text-foreground")}>
              Inactive
            </span>
            <Toggle checked={active} onCheckedChange={handleToggleActive} aria-label="Course student access" />
            <span className={cn(active ? "font-semibold text-foreground" : "text-muted-foreground")}>
              Active
            </span>
          </div>
        </div>
        {course.course_name && <p className="text-body text-foreground">{course.course_name}</p>}
        <div className="mt-1 flex items-end justify-between gap-4">
          {/* term | section — forward-compatible (no schema columns today). */}
          <div className="text-caption text-foreground">
            {course.term && (
              <span>
                {course.term}
                {course.section ? ` | Section ${course.section}` : ""}
              </span>
            )}
          </div>
          {course.course_access_code && (
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <span>
                Access Code:{" "}
                <span className="font-semibold text-foreground">{course.course_access_code}</span>
              </span>
              <button
                type="button"
                onClick={copyCode}
                aria-label="Copy access code"
                className="rounded p-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={MdContentCopy} size={16} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Instructors: assigned list with Remove + per-instructor OCELIA access. */}
      <div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1">
            <h2 className="text-caption font-semibold text-foreground">Instructor(s)</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setAddOpen(true)}
              aria-label="Add instructor"
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
            <p className="py-3 text-caption text-muted-foreground">No instructors assigned yet.</p>
          ) : (
            assigned.map((inst) => (
              <div
                key={inst.user_email}
                className="flex items-center justify-between gap-4 border-b border-border py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-caption font-medium text-foreground">
                    {instructorLabel(inst)}
                  </p>
                  <button
                    type="button"
                    onClick={() => setRemoveTarget(inst)}
                    className="text-caption text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove
                  </button>
                </div>
                <AccessToggle
                  checked={accessOn(inst)}
                  onCheckedChange={(v) => handleToggleAccess(inst.user_email, v)}
                  label={`OCELIA access for ${instructorLabel(inst)}`}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer: Delete course + Duplicate. */}
      <div className="flex items-center gap-4 border-t border-border pt-4">
        <Button
          variant="link"
          className="text-destructive"
          onClick={() => setDeleteOpen(true)}
          disabled={del.isPending}
        >
          Delete course
        </Button>
        <DuplicateCourseDialog course={course} />
      </div>

      {/* Add-instructor picker. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader className="border-b border-border pb-3">
            <DialogTitle>Add an instructor</DialogTitle>
          </DialogHeader>
          <DialogDescription>Give an instructor access to this course.</DialogDescription>
          <div className="flex max-h-72 flex-col overflow-y-auto">
            {unassigned.length === 0 ? (
              <p className="py-3 text-caption text-muted-foreground">
                All instructors are already assigned.
              </p>
            ) : (
              unassigned.map((inst) => (
                <button
                  key={inst.user_email}
                  type="button"
                  onClick={() => handleAdd(inst.user_email)}
                  disabled={enroll.isPending}
                  className="flex items-center justify-between gap-3 border-b border-border px-1 py-3 text-left text-caption transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
                >
                  <span className="truncate font-medium text-foreground">{instructorLabel(inst)}</span>
                  <span className="shrink-0 text-muted-foreground">{inst.user_email}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="Remove instructor?"
        description={
          removeTarget
            ? `Remove ${instructorLabel(removeTarget)} from ${courseCode(course)}? If they need access to this course again, you'll need to add them back.`
            : ""
        }
        confirmLabel="Remove instructor"
        variant="danger"
        loading={unenroll.isPending}
        onConfirm={handleRemove}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete course?"
        description={`You are about to delete ${courseCode(course)} from the OCELIA system. This change is permanent and removes all of the course's content. This can't be undone.`}
        confirmLabel="Delete course"
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
