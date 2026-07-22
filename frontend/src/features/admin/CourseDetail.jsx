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
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
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
 * course header carries the Active/Inactive toggle (course-wide student access)
 * and the access code; the instructor list shows each assigned instructor with a
 * Remove link and a per-instructor OCELIA access toggle (backend track B4); the
 * footer has Delete course + Duplicate (left) and Save changes (right).
 *
 * STAGED EDITING (Option A): the Active toggle, per-instructor access toggles,
 * and instructor add/remove are buffered locally and only committed to the
 * backend when "Save changes" is clicked (active → removes → adds → access, via
 * mutateAsync). "Save changes" is disabled until there are unsaved edits;
 * navigating away discards them. Delete course + Duplicate are separate
 * immediate actions.
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

  // Staged (unsaved) edits — committed only on "Save changes".
  const [pendingActive, setPendingActive] = useState(null) // null = unchanged
  const [pendingAccess, setPendingAccess] = useState({}) // { [email]: boolean }
  const [pendingAdds, setPendingAdds] = useState(() => new Set())
  const [pendingRemoves, setPendingRemoves] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleted, setDeleted] = useState(false)

  // Discard staged edits when switching to another course.
  useEffect(() => {
    setPendingActive(null)
    setPendingAccess({})
    setPendingAdds(new Set())
    setPendingRemoves(new Set())
  }, [courseId])

  const serverActive = course?.course_student_access !== false
  const active = pendingActive ?? serverActive

  const serverAccess = (email) => {
    const inst = assigned.find((x) => x.user_email === email)
    return inst ? inst.access_enabled !== false : true
  }

  // The instructor list as it will look once the staged edits are saved.
  const displayed = useMemo(() => {
    const out = []
    for (const inst of assigned) {
      if (pendingRemoves.has(inst.user_email)) continue
      out.push({ ...inst, access_enabled: pendingAccess[inst.user_email] ?? (inst.access_enabled !== false) })
    }
    for (const email of pendingAdds) {
      const inst = allInstructors.find((x) => x.user_email === email)
      if (inst) out.push({ ...inst, access_enabled: pendingAccess[email] ?? true })
    }
    return out
  }, [assigned, allInstructors, pendingAccess, pendingAdds, pendingRemoves])

  const unassigned = useMemo(() => {
    const shown = new Set(displayed.map((i) => i.user_email))
    return allInstructors.filter((i) => !shown.has(i.user_email))
  }, [displayed, allInstructors])

  const isDirty =
    pendingActive !== null ||
    Object.keys(pendingAccess).length > 0 ||
    pendingAdds.size > 0 ||
    pendingRemoves.size > 0

  // After the course is deleted, leave the pane. Navigating from an effect
  // (rather than inline in the delete's onSuccess) lets the guard observe
  // `when=false` first — deleting the record makes any staged edits moot, so we
  // don't want the unsaved-changes prompt on the way out. (Duplicate keeps the
  // source course, so its navigation is intentionally still guarded.)
  useEffect(() => {
    if (deleted) navigate("/admin/courses")
  }, [deleted, navigate])

  const toggleActive = (value) => setPendingActive(value === serverActive ? null : value)

  const toggleAccess = (email, value) => {
    setPendingAccess((p) => {
      const next = { ...p }
      const isAdd = pendingAdds.has(email)
      if ((!isAdd && value === serverAccess(email)) || (isAdd && value === true)) {
        delete next[email]
      } else {
        next[email] = value
      }
      return next
    })
  }

  const addInstructor = (email) => {
    setPendingRemoves((r) => {
      if (!r.has(email)) return r
      const next = new Set(r)
      next.delete(email)
      return next
    })
    if (!assigned.some((i) => i.user_email === email)) {
      setPendingAdds((a) => new Set(a).add(email))
    }
    setAddOpen(false)
  }

  const removeInstructor = (email) => {
    if (pendingAdds.has(email)) {
      setPendingAdds((a) => {
        const next = new Set(a)
        next.delete(email)
        return next
      })
    } else {
      setPendingRemoves((r) => new Set(r).add(email))
    }
    setPendingAccess((p) => {
      if (!(email in p)) return p
      const next = { ...p }
      delete next[email]
      return next
    })
  }

  const saveChanges = async () => {
    setSaving(true)
    try {
      if (pendingActive !== null && pendingActive !== serverActive) {
        await updateCourseAccess.mutateAsync({ courseId, access: pendingActive })
      }
      for (const em of pendingRemoves) {
        await unenroll.mutateAsync({ courseId, instructorEmail: em })
      }
      for (const em of pendingAdds) {
        await enroll.mutateAsync({ courseId, instructorEmail: em })
      }
      for (const [em, access] of Object.entries(pendingAccess)) {
        if (pendingRemoves.has(em)) continue
        await updateInstructorAccess.mutateAsync({ courseId, instructorEmail: em, access })
      }
      setPendingActive(null)
      setPendingAccess({})
      setPendingAdds(new Set())
      setPendingRemoves(new Set())
      toast.success("Changes saved")
    } catch {
      toast.error("Couldn't save all changes")
    } finally {
      setSaving(false)
    }
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
      <UnsavedChangesPrompt when={isDirty && !deleted} />
      {/* Header: code + Active/Inactive toggle, name, then term|section + access code. */}
      <div className="flex flex-col gap-1 border-b border-border pb-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-h2 font-semibold text-neutral-900">{courseCode(course)}</h1>
          <div className="flex shrink-0 items-center gap-2 text-caption">
            <span className={cn(active ? "text-muted-foreground" : "font-semibold text-foreground")}>
              Inactive
            </span>
            <Toggle checked={active} onCheckedChange={toggleActive} aria-label="Course student access" />
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
          ) : displayed.length === 0 ? (
            <p className="py-3 text-caption text-muted-foreground">No instructors assigned yet.</p>
          ) : (
            displayed.map((inst) => (
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
                    onClick={() => removeInstructor(inst.user_email)}
                    className="text-caption text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove
                  </button>
                </div>
                <AccessToggle
                  checked={inst.access_enabled}
                  onCheckedChange={(v) => toggleAccess(inst.user_email, v)}
                  label={`OCELIA access for ${instructorLabel(inst)}`}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer: Delete course + Duplicate (immediate) · Save changes (commits staged edits). */}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <div className="flex items-center gap-4">
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
        <Button variant="outline" onClick={saveChanges} disabled={!isDirty || saving} loading={saving}>
          Save changes
        </Button>
      </div>

      {/* Add-instructor picker (staged — commits on Save changes). */}
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
                  onClick={() => addInstructor(inst.user_email)}
                  className="flex items-center justify-between gap-3 border-b border-border px-1 py-3 text-left text-caption transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
              setDeleted(true)
            },
          })
        }
      />
    </div>
  )
}
