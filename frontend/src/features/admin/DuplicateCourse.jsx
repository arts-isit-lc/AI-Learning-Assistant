import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "react-toastify"
import { MdContentCopy } from "react-icons/md"
import { useAdminCourses, useDuplicateCourse } from "@/services/queries"
import { COURSE_TERMS } from "@/constants/courseTerms"
import { generateAccessCode, parseCourseCode } from "./CreateCourse"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

/** Dropdown label for a source course: "DEPT NUMBER — Name" (code omitted if absent). */
function courseOptionLabel(c) {
  const code = [c.course_department, c.course_number].filter(Boolean).join(" ")
  return code ? `${code} — ${c.course_name}` : c.course_name
}

/**
 * Duplicate-course modal (Figma 859:6928). A centered dialog over the course
 * list: pick a source course, then review/edit the prefilled Course code, title
 * (" (copy)"), Term, and a freshly generated Access code before duplicating.
 * Submits duplicate_course (backend track B2 — clones the course row + the
 * concept/module OUTLINE server-side; NOT files, embeddings, enrolments, or
 * student data), then opens the new course.
 *
 * Mirrors the Add-course modal's chrome/heights. DATA-GAP NOTE (flagged): the
 * mockup's Primary/Secondary instructor fields have no schema backing and
 * duplicate_course does not enroll instructors, so instructors are omitted here
 * (assign them from the new course's detail pane). Term is optional on duplicate
 * — clearing it keeps the source course's term (server-side COALESCE).
 */
export function DuplicateCourse() {
  const navigate = useNavigate()
  const { data: courses = [] } = useAdminCourses()
  const duplicate = useDuplicateCourse()

  const [sourceCourseId, setSourceCourseId] = useState("")
  const [code, setCode] = useState("")
  const [title, setTitle] = useState("")
  const [term, setTerm] = useState("")
  const [accessCode, setAccessCode] = useState(() => generateAccessCode())
  // Set to the destination once the course is duplicated, so the unsaved-changes
  // guard is disarmed before we navigate to the new course (see effect below).
  const [leaveTo, setLeaveTo] = useState(null)

  const source = courses.find((c) => c.course_id === sourceCourseId)
  const { department, number } = parseCourseCode(code)
  // A source + a valid code/title are required; the access code is auto-generated
  // and Term is optional (kept from the source when left blank).
  const canDuplicate =
    Boolean(sourceCourseId && title.trim() && department && number) && !duplicate.isPending
  // Picking a source (which prefills every field) counts as starting a duplicate.
  const isDirty = Boolean(sourceCourseId)

  // Navigate from an effect (not inline in onSuccess) so the guard observes
  // `when=false` before the route change — otherwise duplicating would trip the
  // unsaved-changes prompt on the way to the new course.
  useEffect(() => {
    if (leaveTo) navigate(leaveTo)
  }, [leaveTo, navigate])

  // Cancel / dismiss navigates directly so a dirty form IS guarded here.
  const close = () => navigate("/admin/courses")

  // Prefill the editable fields from the chosen source course.
  const handleSourceChange = (id) => {
    setSourceCourseId(id)
    const src = courses.find((c) => c.course_id === id)
    if (!src) return
    setCode([src.course_department, src.course_number].filter(Boolean).join(" "))
    setTitle(src.course_name ? `${src.course_name} (copy)` : "")
    setTerm(src.term ?? "")
    setAccessCode(generateAccessCode())
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(accessCode)
      toast.success("Access code copied")
    } catch {
      toast.error("Couldn't copy the code")
    }
  }

  const handleDuplicate = () => {
    duplicate.mutate(
      {
        sourceCourseId,
        courseName: title.trim(),
        department,
        number,
        // Empty term is omitted by the hook so the source term is preserved.
        term,
        accessCode,
        active: source ? source.course_student_access !== false : true,
        systemPrompt: source?.system_prompt ?? "",
      },
      {
        onSuccess: (data) => {
          toast.success("Course duplicated")
          setLeaveTo(`/admin/courses/${data.course_id}`)
        },
        onError: () => toast.error("Failed to duplicate course"),
      }
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <UnsavedChangesPrompt when={isDirty && !leaveTo} />
        <DialogHeader className="border-b border-border pb-2">
          <DialogTitle>Duplicate course</DialogTitle>
        </DialogHeader>
        <DialogDescription className="mt-8 mb-6">
          Review and update the fields below before duplicating your course.
        </DialogDescription>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col">
            <Label htmlFor="dup-course-source">
              Course to duplicate <span className="text-destructive">*</span>
            </Label>
            <Select value={sourceCourseId} onValueChange={handleSourceChange}>
              <SelectTrigger id="dup-course-source" aria-label="Course to duplicate" className="h-7">
                <SelectValue placeholder="Select a course" />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.course_id} value={c.course_id}>
                    {courseOptionLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col">
            <Label htmlFor="dup-course-code">
              Course code <span className="text-destructive">*</span>
            </Label>
            <Input
              id="dup-course-code"
              className="h-7"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. GEOG 210"
              maxLength={30}
            />
          </div>

          <div className="flex flex-col">
            <Label htmlFor="dup-course-title">
              Course title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="dup-course-title"
              className="h-7"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={50}
            />
          </div>

          <div className="flex flex-col">
            <Label htmlFor="dup-course-term">Term</Label>
            <Select value={term} onValueChange={setTerm}>
              <SelectTrigger id="dup-course-term" aria-label="Term" className="h-7">
                <SelectValue placeholder="Select a term" />
              </SelectTrigger>
              <SelectContent>
                {COURSE_TERMS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col mb-6">
            <Label>Access code</Label>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-caption">
                <span className="text-foreground">{accessCode}</span>
                <button
                  type="button"
                  onClick={copyCode}
                  aria-label="Copy access code"
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon icon={MdContentCopy} size={16} />
                </button>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => setAccessCode(generateAccessCode())}
              >
                Generate new code
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border pt-4">
          <Button variant="outline" className="text-[16px]" onClick={close}>
            Cancel
          </Button>
          <Button
            className="text-[16px]"
            onClick={handleDuplicate}
            loading={duplicate.isPending}
            disabled={!canDuplicate}
          >
            Duplicate course
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
