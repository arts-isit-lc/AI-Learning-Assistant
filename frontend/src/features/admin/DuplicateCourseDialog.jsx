import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "react-toastify"
import { useDuplicateCourse } from "@/services/queries"
import { generateAccessCode } from "./CreateCourse"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
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

  // Re-seed the form from the current source course each time the dialog opens.
  const handleOpenChange = (next) => {
    if (next && course) {
      setName(course.course_name ? `${course.course_name} (copy)` : "")
      setDepartment(course.course_department ?? "")
      setNumber(course.course_number != null ? String(course.course_number) : "")
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
        accessCode: generateAccessCode(),
        active: course.course_student_access !== false,
        systemPrompt: course.system_prompt ?? "",
      },
      {
        onSuccess: (data) => {
          setOpen(false)
          toast.success("Course duplicated")
          navigate(`/admin/courses/${data.course_id}`)
        },
        onError: () => toast.error("Failed to duplicate course"),
      }
    )
  }

  return (
    <>
      <Button variant="link" onClick={() => handleOpenChange(true)}>
        Duplicate
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader className="border-b border-border pb-3">
              <DialogTitle>Duplicate course</DialogTitle>
            </DialogHeader>
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
            </div>
            <DialogFooter className="border-t border-border pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={duplicate.isPending} disabled={!canSubmit}>
                Duplicate
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
