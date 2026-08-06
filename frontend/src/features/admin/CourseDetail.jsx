import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toUserMessage } from "@/services/apiError"
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
import { CopyButton } from "@/components/composed/CopyButton"
import { ErrorState } from "@/components/composed/ErrorState"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Skeleton } from "@/components/ui/skeleton"

/** Off/On access toggle with labels (mockup: "Off [switch] On"). */
function AccessToggle({ checked, onCheckedChange, label }) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className={cn("text-caption", checked ? "text-muted-foreground" : "font-semibold text-foreground")}>
        Off
      </span>
      <Toggle checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      <span className={cn("text-caption", checked ? "font-semibold text-success" : "text-muted-foreground")}>
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

  const { data: courses = [], isLoading: coursesLoading } = useAdminCourses()
  const { data: assigned = [], isLoading, isError, error, refetch } = useCourseInstructors(courseId)
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
  const [saveError, setSaveError] = useState(null)
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

  // Discard every staged edit — back to the last-saved (server) state. Powers
  // the Undo button and the post-save reset.
  const discardChanges = () => {
    setPendingActive(null)
    setPendingAccess({})
    setPendingAdds(new Set())
    setPendingRemoves(new Set())
  }

  const saveChanges = async () => {
    setSaving(true)
    setSaveError(null)
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
      discardChanges()
    } catch {
      setSaveError("Some changes couldn't be saved. Please review and try again.")
    } finally {
      setSaving(false)
    }
  }

  if (coursesLoading) {
    // Skeleton the pane header + instructor list while the course list resolves,
    // rather than a line of "Loading course…" text.
    return (
      <div role="status" aria-label="Loading course" className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-72" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (!course) {
    // A delete drops the course from the list a beat before the navigate-away
    // effect fires — don't flash "not found" on the way out.
    if (deleted) return null
    return (
      <ErrorState
        title="Course not found"
        description="This course may have been deleted, or you may not have access to it."
      />
    )
  }

  return (
    <div className="flex flex-col">
      <UnsavedChangesPrompt when={isDirty && !deleted} />
      {/* Header: code + Active/Inactive toggle, name, then term|section + access code. */}
      <div className="flex flex-col border-b border-border pb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-[24px] font-semibold text-neutral-900">{courseCode(course)}</h1>
          <div className="flex shrink-0 items-center gap-2 text-caption">
            <span className={cn(active ? "text-muted-foreground" : "font-semibold text-foreground")}>
              Off
            </span>
            <Toggle checked={active} onCheckedChange={toggleActive} aria-label="Course student access" />
            <span className={cn(active ? "font-semibold text-success" : "text-muted-foreground")}>
              On
            </span>
          </div>
        </div>
        {course.course_name && <p className="text-body text-foreground">{course.course_name}</p>}
        <div className="mt-4 flex items-end justify-between gap-4">
          {/* term | section — forward-compatible (no schema columns today). */}
          <div className="text-lg leading-7 text-foreground">
            {course.term && (
              <span>
                {course.term}
                {course.section ? ` | Section ${course.section}` : ""}
              </span>
            )}
          </div>
          {course.course_access_code && (
            <div className="flex items-center gap-2 text-[16px] text-foreground">
              {/* Access code: 16px, normal weight (per request; mockup Body is 18px). */}
              <span>Access Code: {course.course_access_code}</span>
              <CopyButton value={course.course_access_code} label="Copy access code" />
            </div>
          )}
        </div>
      </div>

      {/* Instructors: assigned list with Remove + per-instructor OCELIA access. */}
      <div>
        <div className="flex items-center justify-between gap-4 mt-2.5 mb-6">
          <div className="flex items-center gap-1">
            <h2 className="text-caption leading-7 mr-4 font-semibold text-foreground">Instructor(s)</h2>
          </div>
          <span className="text-caption leading-7 font-semibold text-foreground">OCELIA access</span>
        </div>

        <div className="mt-2 flex flex-col">
          {isLoading ? (
            <Skeleton className="h-16 w-full" role="status" aria-label="Loading instructors" />
          ) : isError ? (
            <ErrorState
              className="border-0"
              title="Couldn't load instructors"
              description={toUserMessage(error)}
              onRetry={() => refetch()}
            />
          ) : displayed.length === 0 ? (
            <p className="py-3 text-caption text-muted-foreground">No instructors assigned yet.</p>
          ) : (
            displayed.map((inst) => (
              <div
                key={inst.user_email}
                className="flex items-center justify-between gap-4 border-b border-border"
              >
                <div className="min-w-0">
                  <p className="truncate text-2xl leading-9 text-foreground pt-4">
                    {instructorLabel(inst)}
                  </p>
                  <button
                    type="button"
                    onClick={() => removeInstructor(inst.user_email)}
                    className="text-caption text-primary mb-4 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

      {saveError && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {/* Footer: Delete course + Duplicate (immediate) · Save changes (commits staged edits). */}
      <div className="flex items-center justify-between gap-4 pt-4">
        <div className="flex items-center gap-4">
          <Button
            variant="link"
            className="p-0 text-destructive hover:no-underline"
            onClick={() => setDeleteOpen(true)}
            disabled={del.isPending}
          >
            Delete course
          </Button>
          <DuplicateCourseDialog className="ml-6 h-7" course={course} />
        </div>
        {/* Undo + Save (ghost/text, matched across the admin panes + Settings):
            28px tall (h-7 + size-sm padding), 4px radius (rounded), lavender
            (#F2E8FF / primary-subtle) hover. Disabled text is a solid #808080
            (neutral-300 at full opacity — disabled:opacity-100 defeats the base
            fade). Once dirty the text turns #6829C2 (primary); Save also gains a
            #6829C2 border (transparent while disabled so there's no layout
            shift), Undo stays borderless. */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded hover:bg-primary-subtle hover:text-primary disabled:opacity-100",
              isDirty ? "text-primary" : "text-neutral-300"
            )}
            onClick={discardChanges}
            disabled={!isDirty || saving}
          >
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded border hover:bg-primary-subtle hover:text-primary disabled:opacity-100",
              isDirty ? "border-primary text-primary" : "border-transparent text-neutral-300"
            )}
            onClick={saveChanges}
            disabled={!isDirty || saving}
            loading={saving}
          >
            Save changes
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open)
          if (!open) del.reset?.()
        }}
        title="Delete course?"
        description={`You are about to delete ${courseCode(course)} from the OCELIA system. This change is permanent and removes all of the course's content. This can't be undone.`}
        confirmLabel="Delete course"
        loading={del.isPending}
        error={del.isError ? toUserMessage(del.error) : undefined}
        onConfirm={() =>
          del.mutate(courseId, {
            onSuccess: () => {
              setDeleteOpen(false)
              setDeleted(true)
            },
          })
        }
      />
    </div>
  )
}
