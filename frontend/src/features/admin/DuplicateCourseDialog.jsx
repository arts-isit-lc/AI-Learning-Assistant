import { useState } from "react"
import { useNavigate } from "react-router"
import { useDuplicateCourse } from "@/services/queries"
import { COURSE_TERMS } from "@/constants/courseTerms"
import { generateAccessCode, parseCourseCode, COURSE_EXISTS_MESSAGE } from "./CreateCourse"
import { CopyButton } from "@/components/composed/CopyButton"
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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

/**
 * Duplicate-course action (admin course detail footer). Renders the "Duplicate"
 * trigger + a dialog pre-filled from the source course. Because the source is
 * already known here (the detail pane's course), it skips the source dropdown
 * that the Add-course-list Duplicate modal (DuplicateCourse.jsx) opens with, but
 * otherwise mirrors that modal's field set: Course code, Course title (" (copy)"),
 * Term, Section, and a freshly generated Access code — all filled out and ready
 * to review. On submit it calls duplicate_course (backend track B2 — clones the
 * course + concept/module outline + each module's uploaded files server-side;
 * not embeddings or student data) and opens the new course.
 *
 * Term is optional on duplicate (the hook omits an empty term so the source
 * course's term is kept server-side via COALESCE).
 */
export function DuplicateCourseDialog({ course }) {
  const navigate = useNavigate()
  const duplicate = useDuplicateCourse()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState("")
  const [title, setTitle] = useState("")
  const [term, setTerm] = useState("")
  const [section, setSection] = useState("")
  const [accessCode, setAccessCode] = useState(() => generateAccessCode())
  // Set when the duplicate succeeded but some files couldn't be copied. Holds
  // the new course id + failed count so we surface an inline note and let the
  // admin proceed to the new course (rather than silently swallowing it).
  const [copyWarning, setCopyWarning] = useState(null)

  const { department, number } = parseCourseCode(code)

  // Re-seed the form from the current source course each time the dialog opens.
  const handleOpenChange = (next) => {
    if (next && course) {
      setCode([course.course_department, course.course_number].filter(Boolean).join(" "))
      setTitle(course.course_name ? `${course.course_name} (copy)` : "")
      setTerm(course.term ?? "")
      setSection(course.section ?? "")
      setAccessCode(generateAccessCode())
      setCopyWarning(null)
    }
    setOpen(next)
  }

  // A valid code (department + number) and a title are required; the access
  // code is auto-generated and Term is optional (kept from the source when blank).
  const canSubmit =
    Boolean(title.trim() && department && number) && !duplicate.isPending

  const submit = (e) => {
    e.preventDefault()
    if (!canSubmit || !course) return
    duplicate.mutate(
      {
        sourceCourseId: course.course_id,
        courseName: title.trim(),
        department,
        number,
        // Empty term is omitted by the hook so the source term is preserved.
        term,
        // Optional; omitted by the hook when empty so the source section is kept.
        section: section.trim(),
        accessCode,
        active: course.course_student_access !== false,
        systemPrompt: course.system_prompt ?? "",
      },
      {
        onSuccess: (data) => {
          const failed = data.file_copy?.failed ?? []
          if (failed.length) {
            // Duplicate succeeded; some files were skipped. Hold in the dialog
            // so the admin sees the note, then proceeds to the new course.
            setCopyWarning({ courseId: data.course_id, failedCount: failed.length })
            return
          }
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
                Review and update the fields below. This copies the course, its concept/module
                outline, and the uploaded module files. Student data is not copied.
              </DialogDescription>

              <div className="flex flex-col gap-4">
                <div className="flex flex-col">
                  <Label htmlFor="dup-course-code">
                    Course code <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="dup-course-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="e.g. GEOG 210"
                    maxLength={30}
                    autoFocus
                  />
                </div>

                <div className="flex flex-col">
                  <Label htmlFor="dup-course-title">
                    Course title <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="dup-course-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    maxLength={50}
                  />
                </div>

                <div className="flex flex-col">
                  <Label htmlFor="dup-course-term">Term</Label>
                  <Select value={term} onValueChange={setTerm}>
                    <SelectTrigger id="dup-course-term" aria-label="Term">
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

                <div className="flex flex-col">
                  <Label htmlFor="dup-course-section">Section</Label>
                  <Input
                    id="dup-course-section"
                    value={section}
                    onChange={(e) => setSection(e.target.value)}
                    placeholder="e.g. 001"
                    maxLength={20}
                  />
                </div>

                <div className="flex flex-col mb-6">
                  <Label>Access code</Label>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-caption">
                      <span className="text-foreground">{accessCode}</span>
                      <CopyButton value={accessCode} label="Copy access code" />
                    </span>
                    <Button
                      type="button"
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

              {duplicate.isError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {toUserMessage(duplicate.error, { 409: COURSE_EXISTS_MESSAGE })}
                  </AlertDescription>
                </Alert>
              )}
              {copyWarning && (
                <Alert>
                  <AlertDescription>
                    Course duplicated, but {copyWarning.failedCount}{" "}
                    {copyWarning.failedCount === 1 ? "file" : "files"} could not be copied and{" "}
                    {copyWarning.failedCount === 1 ? "was" : "were"} skipped. You can re-upload{" "}
                    {copyWarning.failedCount === 1 ? "it" : "them"} in the new course.
                  </AlertDescription>
                </Alert>
              )}
            </DialogBody>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              {copyWarning ? (
                <Button
                  type="button"
                  className="hover:bg-primary-dark"
                  onClick={() => {
                    setOpen(false)
                    navigate(`/admin/courses/${copyWarning.courseId}`)
                  }}
                >
                  Go to course
                </Button>
              ) : (
                <Button
                  type="submit"
                  className="hover:bg-primary-dark"
                  loading={duplicate.isPending}
                  disabled={!canSubmit}
                >
                  Duplicate
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
