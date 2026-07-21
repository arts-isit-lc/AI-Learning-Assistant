import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "react-toastify"
import { MdContentCopy } from "react-icons/md"
import { useAdminInstructors, useCreateCourse } from "@/services/queries"
import { instructorLabel } from "./InstructorList"
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

// Default course-level prompt (ported from the legacy AdminCreateCourse). The
// Figma Add-course modal omits the prompt + active fields, so they're defaulted
// here and remain editable after creation (Settings tab / the detail toggle).
const DEFAULT_PROMPT =
  "Engage with the student through questions and conversation to identify gaps in their understanding. Address those gaps with targeted explanations, answers to their questions, and references to the relevant course materials. Focus only on concepts needed to resolve the identified misunderstandings rather than providing broad summaries."

/** Generate a 16-char access code formatted XXXX-XXXX-XXXX-XXXX (ported). */
export function generateAccessCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let code = ""
  for (let i = 0; i < 16; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))
  return code.match(/.{1,4}/g).join("-")
}

/** Split a "DEPT NUMBER" code into { department, number } (last token = number). */
export function parseCourseCode(code) {
  const parts = code.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return { department: parts[0] ?? "", number: "" }
  return { department: parts.slice(0, -1).join(" "), number: parts[parts.length - 1] }
}

/**
 * Add-course modal (Figma 859:6864). A centered dialog over the course list:
 * Course code + Course title, an instructor multi-select, and the generated
 * access code (shown up front with "Generate new code"). Submits the course +
 * enrolls the selected instructors, then opens the new course.
 *
 * DATA-GAP NOTE (flagged): the mockup's Term select and the Primary/Secondary
 * instructor distinction (+ per-instructor email/invite) have no schema backing,
 * so Term is omitted and instructors are a flat multi-select of existing
 * instructors. Prompt + active are defaulted (editable post-create).
 */
export function CreateCourse() {
  const navigate = useNavigate()
  const { data: instructors = [] } = useAdminInstructors()
  const create = useCreateCourse()

  const [code, setCode] = useState("")
  const [title, setTitle] = useState("")
  const [accessCode, setAccessCode] = useState(() => generateAccessCode())
  const [selected, setSelected] = useState(() => new Set())

  const { department, number } = parseCourseCode(code)
  const canCreate = Boolean(title.trim() && department && number) && !create.isPending

  const close = () => navigate("/admin/courses")

  const toggleInstructor = (email) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(accessCode)
      toast.success("Access code copied")
    } catch {
      toast.error("Couldn't copy the code")
    }
  }

  const handleCreate = () => {
    create.mutate(
      {
        courseName: title.trim(),
        department,
        number,
        accessCode,
        active: true,
        systemPrompt: DEFAULT_PROMPT,
        instructorEmails: [...selected],
      },
      {
        onSuccess: (data) => {
          toast.success("Course created")
          navigate(`/admin/courses/${data.course_id}`)
        },
        onError: () => toast.error("Failed to create course"),
      }
    )
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="border-b border-border pb-3">
          <DialogTitle>Add course</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          To add a new course to the OCELIA system please fill out the following fields. Fields marked
          with <span className="text-destructive">*</span> are mandatory for course creation.
        </DialogDescription>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-course-code">
              Course code <span className="text-destructive">*</span>
            </Label>
            <Input
              id="add-course-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. GEOG 210"
              maxLength={30}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-course-title">
              Course title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="add-course-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={50}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Instructors</Label>
            {instructors.length === 0 ? (
              <p className="text-caption text-muted-foreground">No instructors to assign yet.</p>
            ) : (
              <fieldset className="flex max-h-40 flex-col gap-2 overflow-y-auto">
                <legend className="sr-only">Instructors</legend>
                {instructors.map((instructor) => (
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
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Access code</Label>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-caption">
                <span className="font-semibold text-foreground">{accessCode}</span>
                <button
                  type="button"
                  onClick={copyCode}
                  aria-label="Copy access code"
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon icon={MdContentCopy} size={16} />
                </button>
              </span>
              <Button variant="outline" size="sm" onClick={() => setAccessCode(generateAccessCode())}>
                Generate new code
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border pt-4">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={handleCreate} loading={create.isPending} disabled={!canCreate}>
            Add course
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
