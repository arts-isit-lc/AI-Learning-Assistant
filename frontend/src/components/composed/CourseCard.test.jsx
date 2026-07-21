import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CourseCard } from "./CourseCard"

describe("CourseCard", () => {
  it("renders the course code and name", () => {
    render(<CourseCard code="GEOG 250" name="Cities" />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.getByText("Cities")).toBeInTheDocument()
  })

  it("renders the progress line and an IN PROGRESS status", () => {
    render(
      <CourseCard
        code="GEOG 312"
        name="Climate"
        progress={{ percent: 42, completed: 8, total: 14 }}
        status="in_progress"
      />
    )
    expect(screen.getByText("42%")).toBeInTheDocument()
    expect(screen.getByText("(8/14 concepts completed)")).toBeInTheDocument()
    expect(screen.getByText("IN PROGRESS")).toBeInTheDocument()
  })

  it("shows COMPLETED for a fully-complete course", () => {
    render(
      <CourseCard
        code="GEOG 250"
        name="Cities"
        progress={{ percent: 100, completed: 12, total: 12 }}
        status="completed"
      />
    )
    expect(screen.getByText("COMPLETED")).toBeInTheDocument()
  })

  it("opens on click when onOpen is provided", async () => {
    const onOpen = vi.fn()
    render(<CourseCard code="GEOG 250" name="Cities" onOpen={onOpen} />)
    await userEvent.click(screen.getByRole("button", { name: /GEOG 250/ }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("is not interactive when inactive and shows ACCESS REQUESTED", () => {
    const onOpen = vi.fn()
    render(
      <CourseCard
        code="GEOG 432"
        name="Radical Traditions"
        state="inactive"
        status="access_requested"
        onOpen={onOpen}
      />
    )
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("ACCESS REQUESTED")).toBeInTheDocument()
  })

  it("does not show progress numbers while loading", () => {
    render(<CourseCard code="GEOG 250" name="Cities" loading />)
    expect(screen.getByText("GEOG 250")).toBeInTheDocument()
    expect(screen.queryByText(/concepts completed/)).toBeNull()
  })
})
