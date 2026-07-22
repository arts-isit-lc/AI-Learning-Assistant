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

/** "DEPT NUMBER" course code. */
function courseCode(course) {
  return `${String(course.course_department ?? "").toUpperCase()} ${course.course_number ?? ""}`.trim()
}

/** "DEPT NUMBER — Name" label for a course (used for accessible names). */
function courseLabel(course) {
  const code = courseCode(course)
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
 * a profile header, the instructor's assigned courses (each with a Remove link +
 * a per-course OCELIA access toggle, backend track B4), and a footer with
 * Delete instructor (left) + Save changes (right).
 *
 * STAGED EDITING (Option A): the access toggles and course add/remove are
 * buffered locally and only committed to the backend when "Save changes" is
 * clicked (removes → adds → access, via mutateAsync). "Save changes" is disabled
 * until there are unsaved edits; navigating away discards them. "Delete
 * instructor" is a separate terminal action that runs immediately (with a
 * confirm), independent of the staged edits.
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

  // Staged (unsaved) edits — committed only on "Save changes".
  const [pendingAccess, setPendingAccess] = useState({}) // { [courseId]: boolean }
  const [pendingAdds, setPendingAdds] = useState(() => new Set())
  const [pendingRemoves, setPendingRemoves] = useState(() => new Set())
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [deleted, setDeleted] = useState(false)

  // Discard staged edits when switching to another instructor.
  useEffect(() => {
    setPendingAccess({})
    setPendingAdds(new Set())
    setPendingRemoves(new Set())
  }, [email])

  // Server access for a course (added-but-unsaved courses default to ON — the
  // backend Enrolments.access_enabled default is TRUE).
  const serverAccess = (courseId) => {
    const c = assigned.find((x) => x.course_id === courseId)
    return c ? c.access_enabled !== false : true
  }

  // The assigned list as it will look once the staged edits are saved.
  const displayed = useMemo(() => {
    const out = []
    for (const c of assigned) {
      if (pendingRemoves.has(c.course_id)) continue
      out.push({ ...c, access_enabled: pendingAccess[c.course_id] ?? (c.access_enabled !== false) })
    }
    for (const id of pendingAdds) {
      const c = allCourses.find((x) => x.course_id === id)
      if (c) out.push({ ...c, access_enabled: pendingAccess[id] ?? true })
    }
    return out
  }, [assigned, allCourses, pendingAccess, pendingAdds, pendingRemoves])

  const unassigned = useMemo(() => {
    const shownIds = new Set(displayed.map((c) => c.course_id))
    return allCourses.filter((c) => !shownIds.has(c.course_id))
  }, [displayed, allCourses])

  const isDirty =
    Object.keys(pendingAccess).length > 0 || pendingAdds.size > 0 || pendingRemoves.size > 0

  // After the instructor is deleted, leave the pane. Navigating from an effect
  // (rather than inline in the delete's onSuccess) lets the guard observe
  // `when=false` first — deleting the record makes any staged edits moot, so we
  // don't want the unsaved-changes prompt on the way out.
  useEffect(() => {
    if (deleted) navigate("/admin/instructors")
  }, [deleted, navigate])

  const toggleAccess = (courseId, value) => {
    setPendingAccess((p) => {
      const next = { ...p }
      const isAdd = pendingAdds.has(courseId)
      // Toggling back to the server (or default-ON for adds) value clears the edit.
      if ((!isAdd && value === serverAccess(courseId)) || (isAdd && value === true)) {
        delete next[courseId]
      } else {
        next[courseId] = value
      }
      return next
    })
  }

  const addCourse = (courseId) => {
    // Re-adding a course staged for removal just cancels the removal.
    setPendingRemoves((r) => {
      if (!r.has(courseId)) return r
      const next = new Set(r)
      next.delete(courseId)
      return next
    })
    // A brand-new assignment (not already a server course) → stage an add.
    if (!assigned.some((c) => c.course_id === courseId)) {
      setPendingAdds((a) => new Set(a).add(courseId))
    }
    setAddOpen(false)
  }

  const removeCourse = (courseId) => {
    if (pendingAdds.has(courseId)) {
      setPendingAdds((a) => {
        const next = new Set(a)
        next.delete(courseId)
        return next
      })
    } else {
      setPendingRemoves((r) => new Set(r).add(courseId))
    }
    setPendingAccess((p) => {
      if (!(courseId in p)) return p
      const next = { ...p }
      delete next[courseId]
      return next
    })
  }

  const saveChanges = async () => {
    setSaving(true)
    try {
      for (const courseId of pendingRemoves) {
        await unenroll.mutateAsync({ courseId, instructorEmail: email })
      }
      for (const courseId of pendingAdds) {
        await enroll.mutateAsync({ courseId, instructorEmail: email })
      }
      // Enroll first (above) so an added course exists before its access is set.
      for (const [courseId, access] of Object.entries(pendingAccess)) {
        if (pendingRemoves.has(courseId)) continue
        await updateInstructorAccess.mutateAsync({ courseId, instructorEmail: email, access })
      }
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

  return (
    <div className="flex flex-col gap-6">
      <UnsavedChangesPrompt when={isDirty && !deleted} />
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
          ) : displayed.length === 0 ? (
            <p className="py-3 text-caption text-muted-foreground">No courses assigned yet.</p>
          ) : (
            displayed.map((course) => (
              <div
                key={course.course_id}
                className="flex items-center justify-between gap-4 border-b border-border py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-lg text-neutral-900">{courseCode(course)}</p>
                  {course.course_name && (
                    <p className="truncate text-caption text-foreground">{course.course_name}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => removeCourse(course.course_id)}
                    className="text-caption text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Remove
                  </button>
                </div>
                <AccessToggle
                  checked={course.access_enabled}
                  onCheckedChange={(v) => toggleAccess(course.course_id, v)}
                  label={`OCELIA access for ${courseLabel(course)}`}
                />
              </div>
            ))
          )}
        </div>
      </div>

      {/* Footer: Delete instructor (immediate, terminal) + Save changes (commits
          the staged edits; disabled until there are unsaved changes). */}
      <div className="flex items-center justify-between gap-4 pt-4">
        <Button
          variant="link"
          className="text-destructive"
          onClick={() => setRemoveOpen(true)}
          disabled={lower.isPending}
        >
          Delete instructor
        </Button>
        <Button
          variant="ghost"
          className="text-neutral-300"
          onClick={saveChanges}
          disabled={!isDirty || saving}
          loading={saving}
        >
          Save changes
        </Button>
      </div>

      {/* Assign-course picker (staged — commits on Save changes). */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader className="border-b border-border pb-3">
            <DialogTitle>Assign a course</DialogTitle>
          </DialogHeader>
          <DialogDescription>Give this instructor access to a course.</DialogDescription>
          <div className="flex max-h-72 flex-col overflow-y-auto">
            {unassigned.length === 0 ? (
              <p className="py-3 text-caption text-muted-foreground">
                This instructor is already assigned to every course.
              </p>
            ) : (
              unassigned.map((course) => (
                <button
                  key={course.course_id}
                  type="button"
                  onClick={() => addCourse(course.course_id)}
                  className="border-b border-border px-1 py-3 text-left text-caption font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
        title="Delete instructor?"
        description={`Remove ${instructor ? instructorLabel(instructor) : email} as an instructor? Their instructor role and course assignments are removed. Their account and any student data are unaffected.`}
        confirmLabel="Delete instructor"
        variant="danger"
        loading={lower.isPending}
        onConfirm={() =>
          lower.mutate(email, {
            onSuccess: () => {
              setRemoveOpen(false)
              toast.success("Instructor removed")
              setDeleted(true)
            },
          })
        }
      />
    </div>
  )
}
