import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const duplicate = {
  mutate: vi.fn((_vars, opts) => opts?.onSuccess?.({ course_id: "new-course" })),
  isPending: false,
}
const navigate = vi.fn()

vi.mock("@/services/queries", () => ({
  useDuplicateCourse: () => duplicate,
  // CreateCourse (imported for generateAccessCode) references these; never called here.
  useAdminInstructors: () => ({ data: [] }),
  useCreateCourse: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useNavigate: () => navigate }
})

import { DuplicateCourseDialog } from "./DuplicateCourseDialog"

const COURSE = {
  course_id: "c1",
  course_name: "Intro",
  course_department: "geog",
  course_number: "250",
  course_student_access: true,
  system_prompt: "You are a tutor.",
  section: "001",
}

beforeEach(() => {
  duplicate.mutate.mockClear()
  navigate.mockClear()
})

describe("DuplicateCourseDialog", () => {
  it("gives the trigger the admin nav hover (rounded #F2E8FF fill / #2E0666 text, no underline)", () => {
    render(<DuplicateCourseDialog course={COURSE} />)
    // Trigger only (dialog closed) — matches the Instructors/Courses nav-link hover.
    const trigger = screen.getByRole("button", { name: "Duplicate" })
    expect(trigger).toHaveClass("rounded")
    expect(trigger).toHaveClass("hover:bg-primary-subtle")
    expect(trigger).toHaveClass("hover:text-primary-dark")
    expect(trigger).not.toHaveClass("hover:underline")
  })

  it("hovers the dialog Duplicate button to #2E0666 (primary-dark)", async () => {
    render(<DuplicateCourseDialog course={COURSE} />)
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("button", { name: "Duplicate" })).toHaveClass("hover:bg-primary-dark")
  })

  it("pre-fills from the source course and duplicates on submit", async () => {
    render(<DuplicateCourseDialog course={COURSE} />)
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }))

    const dialog = await screen.findByRole("dialog")
    // Name is pre-filled as "<source> (copy)"; Section is seeded from the source.
    expect(within(dialog).getByLabelText("Course name")).toHaveValue("Intro (copy)")
    expect(within(dialog).getByLabelText("Section")).toHaveValue("001")

    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }))

    expect(duplicate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceCourseId: "c1",
        courseName: "Intro (copy)",
        department: "geog",
        number: "250",
        section: "001",
        active: true,
        systemPrompt: "You are a tutor.",
        accessCode: expect.any(String),
      }),
      expect.any(Object)
    )
    // On success it opens the new course.
    expect(navigate).toHaveBeenCalledWith("/admin/courses/new-course")
  })

  it("shows an inline error in the dialog when duplication fails", async () => {
    duplicate.isError = true
    duplicate.error = { status: 500 }
    render(<DuplicateCourseDialog course={COURSE} />)
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/on our end/i)
    duplicate.isError = false
    duplicate.error = null
  })
})
