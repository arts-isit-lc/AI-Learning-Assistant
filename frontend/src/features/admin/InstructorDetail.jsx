import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { MdAdd } from "react-icons/md"
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
import { Icon } from "@/components/ui/icon"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { MultiSelect } from "@/components/composed/MultiSelect"
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
  const [addOpen, setAddOpen] = useState(false)
  const [picked, setPicked] = useState([]) // courses selected in the assign picker (uncommitted)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
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

  // Courses not already shown (assigned or staged) — the pool the "+" picker
  // offers to assign this instructor to.
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
  }

  // Open/close the assign picker, discarding any uncommitted selection on close.
  const setPickerOpen = (open) => {
    setAddOpen(open)
    if (!open) setPicked([])
  }

  // Commit the picker's multi-selection: stage every chosen course, then close.
  const assignPicked = () => {
    picked.forEach(addCourse)
    setPickerOpen(false)
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
      // Wait for the assigned-courses cache to reflect the saved state before
      // clearing the staged edits. The mutations' onSuccess invalidations kick
      // off a *background* refetch; if we discard first, the toggles briefly
      // render the stale pre-save server value (a visible on→off→on flip) until
      // that refetch lands. Awaiting it means the staged value hands off to an
      // identical server value with no intermediate render.
      await refetch?.()
      discardChanges()
    } catch {
      setSaveError("Some changes couldn't be saved. Please review and try again.")
    } finally {
      setSaving(false)
    }
  }

  // Courses staged for removal (resolved to their objects) — drives the confirm
  // copy ("remove <instructor> from <course code(s)>").
  const removedCourses = [...pendingRemoves]
    .map((id) => assigned.find((c) => c.course_id === id))
    .filter(Boolean)
  const removedCodes = removedCourses.map(courseCode).join(", ")

  // "Save changes" gates on staged course removals: unenrolling an instructor
  // tears down their access to that course and (per the invite model) means
  // re-adding them to restore it, so we confirm before committing. Any other
  // edits (access toggles, adds) save straight through.
  const handleSaveClick = () => {
    if (pendingRemoves.size > 0) setRemoveConfirmOpen(true)
    else saveChanges()
  }

  // Confirmed removal → run the actual save, then close the confirm. saveChanges
  // owns its own error handling (the page-level Alert) and clears the staged
  // edits on success; on failure the staged edits remain so the user can retry.
  const confirmRemoveAndSave = async () => {
    await saveChanges()
    setRemoveConfirmOpen(false)
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
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setPickerOpen(true)}
              aria-label="Assign course"
            >
              <Icon icon={MdAdd} size={18} />
            </Button>
          </div>
          <span className="text-caption font-semibold text-foreground">OCELIA access</span>
        </div>

        <div className="flex flex-col">
          {isLoading ? (
            <Skeleton className="h-16 w-full" role="status" aria-label="Loading assigned courses" />
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
            (#F2E8FF / primary-subtle) hover. Inactive (disabled) is #BFBFBF
            (neutral-400) text on a white (#FFF / bg-background) fill, at full
            opacity — disabled:opacity-100 defeats the base fade. Once active
            (dirty) the text turns #6829C2 (primary) and the
            buttons take on the ghost-primary interaction: hover darkens the text to
            #2E0666 (primary-dark) on the lavender surface, and the press deepens
            the surface to #AA78F0 (primary-active) with the same #2E0666 text. Save
            also gains a #6829C2 border (transparent while disabled so there's no
            layout shift), Undo stays borderless. */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark disabled:opacity-100",
              isDirty ? "text-primary" : "bg-background text-neutral-400"
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
              "h-7 rounded border hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark disabled:opacity-100",
              isDirty ? "border-primary text-primary" : "border-transparent bg-background text-neutral-400"
            )}
            onClick={handleSaveClick}
            disabled={!isDirty || saving}
            loading={saving}
          >
            Save changes
          </Button>
        </div>
      </div>

      {/* Assign-course picker (staged — commits on Save changes). Multi-select
          from the unassigned pool, then Assign stages every pick at once. */}
      <Dialog open={addOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign courses</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {unassigned.length === 0 ? (
              <DialogDescription>
                This instructor is already assigned to every course.
              </DialogDescription>
            ) : (
              <>
                <DialogDescription>
                  Give this instructor access to one or more courses.
                </DialogDescription>
                <MultiSelect
                  aria-label="Courses to assign"
                  placeholder="Select courses"
                  options={unassigned.map((course) => ({
                    value: course.course_id,
                    label: courseLabel(course),
                  }))}
                  value={picked}
                  onChange={setPicked}
                />
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)}>
              Cancel
            </Button>
            <Button
              className="hover:bg-primary-dark"
              onClick={assignPicked}
              disabled={picked.length === 0}
            >
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove-course confirmation (mockup 859:7167). Gates "Save changes"
          whenever a course is staged for removal. Confirm commits the save;
          Cancel just closes (the removal stays staged — Undo restores it). */}
      <ConfirmDialog
        open={removeConfirmOpen}
        onOpenChange={setRemoveConfirmOpen}
        title="Remove course?"
        description={
          <>
            You are about to remove{" "}
            <span className="font-semibold text-neutral-900">
              {instructor ? instructorLabel(instructor) : titleCase(email)}
            </span>{" "}
            from <span className="font-semibold text-neutral-900">{removedCodes}</span>.
            <br />
            <br />
            If the instructor needs to access this course in the future, you will need to add
            them again.
          </>
        }
        confirmLabel="Remove course"
        cancelLabel="Cancel"
        loading={saving}
        onConfirm={confirmRemoveAndSave}
      />

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
