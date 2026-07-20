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
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { DuplicateCourseDialog } from "./DuplicateCourseDialog"

const COURSE = {
  course_id: "c1",
  course_name: "Intro",
  course_department: "geog",
  course_number: "250",
  course_student_access: true,
  system_prompt: "You are a tutor.",
}

beforeEach(() => {
  duplicate.mutate.mockClear()
  navigate.mockClear()
})

describe("DuplicateCourseDialog", () => {
  it("pre-fills from the source course and duplicates on submit", async () => {
    render(<DuplicateCourseDialog course={COURSE} />)
    await userEvent.click(screen.getByRole("button", { name: "Duplicate" }))

    const dialog = await screen.findByRole("dialog")
    // Name is pre-filled as "<source> (copy)".
    expect(within(dialog).getByLabelText("Course name")).toHaveValue("Intro (copy)")

    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }))

    expect(duplicate.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceCourseId: "c1",
        courseName: "Intro (copy)",
        department: "geog",
        number: "250",
        active: true,
        systemPrompt: "You are a tutor.",
        accessCode: expect.any(String),
      }),
      expect.any(Object)
    )
    // On success it opens the new course.
    expect(navigate).toHaveBeenCalledWith("/admin/courses/new-course")
  })
})
