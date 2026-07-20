import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "react-toastify"
import { useAdminInstructors, useCreateCourse } from "@/services/queries"
import { instructorLabel } from "./InstructorList"
import { BackButton } from "@/components/composed/BackButton"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Toggle } from "@/components/ui/toggle"

// Default course-level prompt (ported from the legacy AdminCreateCourse).
const DEFAULT_PROMPT =
  "Engage with the student through questions and conversation to identify gaps in their understanding. Address those gaps with targeted explanations, answers to their questions, and references to the relevant course materials. Focus only on concepts needed to resolve the identified misunderstandings rather than providing broad summaries."

/** Generate a 16-char access code formatted XXXX-XXXX-XXXX-XXXX (ported). */
export function generateAccessCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let code = ""
  for (let i = 0; i < 16; i++) code += chars.charAt(Math.floor(Math.random() * chars.length))
  return code.match(/.{1,4}/g).join("-")
}

/**
 * Create-course form (right pane of /admin/courses/new). The access code is
 * generated client-side at submit (there's no server mint route). On success it
 * creates the course, enrolls the selected instructors, and opens the new course.
 */
export function CreateCourse() {
  const navigate = useNavigate()
  const { data: instructors = [] } = useAdminInstructors()
  const create = useCreateCourse()

  const [name, setName] = useState("")
  const [department, setDepartment] = useState("")
  const [number, setNumber] = useState("")
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [active, setActive] = useState(true)
  const [selected, setSelected] = useState(() => new Set())

  const canCreate =
    Boolean(name.trim() && department.trim() && number.trim() && prompt.trim()) && !create.isPending

  const toggleInstructor = (email) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })

  const handleNumberChange = (e) => {
    const value = e.target.value
    if (/^\d*$/.test(value)) setNumber(value)
  }

  const handleCreate = () => {
    create.mutate(
      {
        courseName: name.trim(),
        department: department.trim(),
        number: number.trim(),
        accessCode: generateAccessCode(),
        active,
        systemPrompt: prompt,
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
    <div className="flex flex-col gap-6">
      <BackButton onClick={() => navigate("/admin/courses")}>Back to courses</BackButton>
      <h1 className="text-h4 font-semibold text-navy">Create a course</h1>

      <Card>
        <CardHeader>
          <CardTitle>Course details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="course-name">Course name</Label>
            <Input id="course-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={50} />
          </div>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="course-department">Department</Label>
              <Input
                id="course-department"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. GEOG"
                maxLength={20}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="course-number">Course number</Label>
              <Input
                id="course-number"
                value={number}
                onChange={handleNumberChange}
                inputMode="numeric"
                placeholder="e.g. 250"
                maxLength={10}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="course-prompt">Course prompt</Label>
            <Textarea id="course-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} />
          </div>
          <div className="flex items-center gap-2">
            <Toggle id="course-active" checked={active} onCheckedChange={setActive} />
            <Label htmlFor="course-active">Active — students can access this course</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assign instructors</CardTitle>
        </CardHeader>
        <CardContent>
          {instructors.length === 0 ? (
            <p className="text-caption text-muted-foreground">No instructors to assign yet.</p>
          ) : (
            <fieldset className="flex flex-col gap-2">
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
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => navigate("/admin/courses")}>
          Cancel
        </Button>
        <Button onClick={handleCreate} loading={create.isPending} disabled={!canCreate}>
          Create course
        </Button>
      </div>
    </div>
  )
}
