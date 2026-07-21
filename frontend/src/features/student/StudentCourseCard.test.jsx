import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StudentCourseCard } from "./StudentCourseCard"

const course = {
  course_id: "c1",
  course_department: "geog",
  course_number: "250",
  course_name: "cities",
}

describe("StudentCourseCard", () => {
  it("renders the code + title and the progress line from the summary", () => {
    render(
      <StudentCourseCard
        course={course}
        progress={{ percent: 50, completed: 1, total: 2 }}
        onOpen={() => {}}
      />
    )
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("Cities")).toBeInTheDocument()
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.getByText("(1/2 concepts completed)")).toBeInTheDocument()
    expect(screen.getByText("IN PROGRESS")).toBeInTheDocument()
  })

  it("marks a fully-complete course COMPLETED", () => {
    render(
      <StudentCourseCard
        course={course}
        progress={{ percent: 100, completed: 3, total: 3 }}
        onOpen={() => {}}
      />
    )
    expect(screen.getByText("COMPLETED")).toBeInTheDocument()
  })

  it("shows just the code + title when there is no progress", () => {
    render(<StudentCourseCard course={course} progress={null} onOpen={() => {}} />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.queryByText(/concepts completed/)).toBeNull()
  })

  it("opens the course on click", async () => {
    const onOpen = vi.fn()
    render(<StudentCourseCard course={course} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole("button", { name: /GEOG 250/ }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
