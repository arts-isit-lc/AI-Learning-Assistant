import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toUserMessage } from "@/services/apiError"
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
import { ErrorState } from "@/components/composed/ErrorState"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Skeleton } from "@/components/ui/skeleton"

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
      <span className={cn("text-caption", checked ? "font-semibold text-success" : "text-muted-foreground")}>
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
  const { data: assigned = [], isLoading, isError, error, refetch } = useInstructorAssignedCourses(email)
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
  const [saveError, setSaveError] = useState(null)
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

  // Discard every staged edit — back to the last-saved (server) state. Powers
  // the Undo button and the post-save reset.
  const discardChanges = () => {
    setPendingAccess({})
    setPendingAdds(new Set())
    setPendingRemoves(new Set())
  }

  const saveChanges = async () => {
    setSaving(true)
    setSaveError(null)
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
      discardChanges()
    } catch {
      setSaveError("Some changes couldn't be saved. Please review and try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col">
      <UnsavedChangesPrompt when={isDirty && !deleted} />
      <ProfileHeader
        user={{ name: instructor ? instructorLabel(instructor) : titleCase(email), email }}
        subtitle={named ? email : "Invited — awaiting signup"}
      />

      {/* Assigned courses: each with Remove + per-course OCELIA access toggle. */}
      <div>
        <div className="flex items-center justify-between gap-4 mb-6 mt-2.5">
          <div className="flex items-center gap-1">
            <h2 className="text-caption font-semibold text-foreground">Assigned courses</h2>
          </div>
          <span className="text-caption font-semibold text-foreground">OCELIA access</span>
        </div>

        <div className="flex flex-col">
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : isError ? (
            <ErrorState
              className="border-0"
              title="Couldn't load assigned courses"
              description={toUserMessage(error)}
              onRetry={() => refetch()}
            />
          ) : displayed.length === 0 ? (
            <p className="py-3 text-caption text-muted-foreground">No courses assigned yet.</p>
          ) : (
            displayed.map((course) => (
              <div
                key={course.course_id}
                className="flex items-center justify-between gap-4 border-b border-border"
              >
                <div className="min-w-0">
                  <p className="truncate text-lg text-neutral-900 pt-4">{courseCode(course)}</p>
                  {course.course_name && (
                    <p className="truncate text-lg text-foreground">{course.course_name}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => removeCourse(course.course_id)}
                    className="text-caption text-primary leading-7 mb-4 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

      {saveError && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {/* Footer: Delete instructor (immediate, terminal) + Save changes (commits
          the staged edits; disabled until there are unsaved changes). */}
      <div className="flex items-center justify-between gap-4 pt-4">
        <Button
          variant="link"
          className="p-0 text-destructive hover:no-underline"
          onClick={() => setRemoveOpen(true)}
          disabled={lower.isPending}
        >
          Delete instructor
        </Button>
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
        open={removeOpen}
        onOpenChange={(open) => {
          setRemoveOpen(open)
          if (!open) lower.reset?.()
        }}
        title="Delete instructor?"
        description={`Remove ${instructor ? instructorLabel(instructor) : email} as an instructor? Their instructor role and course assignments are removed. Their account and any student data are unaffected.`}
        confirmLabel="Delete instructor"
        loading={lower.isPending}
        error={lower.isError ? toUserMessage(lower.error) : undefined}
        onConfirm={() =>
          lower.mutate(email, {
            onSuccess: () => {
              setRemoveOpen(false)
              setDeleted(true)
            },
          })
        }
      />
    </div>
  )
}
