import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ProfileHeader } from "./ProfileHeader"

describe("ProfileHeader", () => {
  it("renders the name heading and subtitle", () => {
    render(<ProfileHeader user={{ name: "Dr. Smith" }} subtitle="Instructor · 3 courses" />)
    expect(screen.getByRole("heading", { name: "Dr. Smith" })).toBeInTheDocument()
    expect(screen.getByText("Instructor · 3 courses")).toBeInTheDocument()
  })
})
