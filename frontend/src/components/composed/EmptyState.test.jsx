import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { EmptyState } from "./EmptyState"

describe("EmptyState", () => {
  it("renders the title, description, and action", () => {
    render(
      <EmptyState
        title="No courses yet"
        description="Join a course to get started."
        action={<button type="button">Join course</button>}
      />
    )
    expect(screen.getByRole("heading", { name: "No courses yet" })).toBeInTheDocument()
    expect(screen.getByText("Join a course to get started.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Join course" })).toBeInTheDocument()
  })
})
