import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CourseCard } from "./CourseCard"

const course = { course_department: "geog", course_number: "250", course_name: "Intro to Geography" }

describe("CourseCard", () => {
  it("renders the course code and name", () => {
    render(<CourseCard course={course} />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("Intro to Geography")).toBeInTheDocument()
  })

  it("is a button that opens on click when onOpen is provided", async () => {
    const onOpen = vi.fn()
    render(<CourseCard course={course} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole("button", { name: /GEOG 250/ }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("is not interactive when inactive", () => {
    const onOpen = vi.fn()
    render(<CourseCard course={course} onOpen={onOpen} state="inactive" />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Inactive")).toBeInTheDocument()
  })
})
