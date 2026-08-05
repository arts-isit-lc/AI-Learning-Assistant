import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useDuplicateCourse } from "@/services/queries"
import { generateAccessCode, COURSE_EXISTS_MESSAGE } from "./CreateCourse"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toUserMessage } from "@/services/apiError"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

/**
 * Duplicate-course action (admin course detail footer). Renders the "Duplicate"
 * trigger + a dialog pre-filled from the source course (name + " (copy)",
 * department, number) with a freshly generated access code. On submit it calls
 * duplicate_course (backend track B2 — clones the course + concept/module outline
 * server-side; not files or student data) and opens the new course.
 */
export function DuplicateCourseDialog({ course }) {
  const navigate = useNavigate()
  const duplicate = useDuplicateCourse()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [department, setDepartment] = useState("")
  const [number, setNumber] = useState("")
  const [section, setSection] = useState("")

  // Re-seed the form from the current source course each time the dialog opens.
  const handleOpenChange = (next) => {
    if (next && course) {
      setName(course.course_name ? `${course.course_name} (copy)` : "")
      setDepartment(course.course_department ?? "")
      setNumber(course.course_number != null ? String(course.course_number) : "")
      setSection(course.section ?? "")
    }
    setOpen(next)
  }

  const handleNumberChange = (e) => {
    if (/^\d*$/.test(e.target.value)) setNumber(e.target.value)
  }

  const canSubmit =
    Boolean(name.trim() && department.trim() && number.trim()) && !duplicate.isPending

  const submit = (e) => {
    e.preventDefault()
    if (!canSubmit || !course) return
    duplicate.mutate(
      {
        sourceCourseId: course.course_id,
        courseName: name.trim(),
        department: department.trim(),
        number: number.trim(),
        // Optional; omitted by the hook when empty so the source section is kept.
        section: section.trim(),
        accessCode: generateAccessCode(),
        active: course.course_student_access !== false,
        systemPrompt: course.system_prompt ?? "",
      },
      {
        onSuccess: (data) => {
          setOpen(false)
          navigate(`/admin/courses/${data.course_id}`)
        },
      }
    )
  }

  return (
    <>
      {/* Hover matches the admin nav links (Instructors/Courses): a rounded
          brand-"lightest" fill (#F2E8FF / --primary-subtle) with "Faculty of
          Arts/Dark" text (#2E0666 / --primary-dark), not the link underline.
          28px tall (h-7 + size-sm padding) to match the footer's Undo/Save. */}
      <Button
        variant="link"
        size="sm"
        className="h-7 rounded hover:bg-primary-subtle hover:text-primary-dark hover:no-underline"
        onClick={() => handleOpenChange(true)}
      >
        Duplicate
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          {/* min-h-0 + flex-1 lets the form fill the capped modal so DialogBody
              can scroll between the pinned header and footer. */}
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-8">
            <DialogHeader>
              <DialogTitle>Duplicate course</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <DialogDescription>
                Review and update the fields below. This copies the course and its concept/module
                outline — reference files and student data are not copied.
              </DialogDescription>
              <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dup-name">Course name</Label>
                <Input
                  id="dup-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={50}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="dup-department">Department</Label>
                  <Input
                    id="dup-department"
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    maxLength={20}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="dup-number">Course number</Label>
                  <Input
                    id="dup-number"
                    value={number}
                    onChange={handleNumberChange}
                    inputMode="numeric"
                    maxLength={10}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dup-section">Section</Label>
                <Input
                  id="dup-section"
                  value={section}
                  onChange={(e) => setSection(e.target.value)}
                  placeholder="e.g. 001"
                  maxLength={20}
                />
              </div>
            </div>
              {duplicate.isError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {toUserMessage(duplicate.error, { 409: COURSE_EXISTS_MESSAGE })}
                  </AlertDescription>
                </Alert>
              )}
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                className="hover:bg-primary-dark"
                loading={duplicate.isPending}
                disabled={!canSubmit}
              >
                Duplicate
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
