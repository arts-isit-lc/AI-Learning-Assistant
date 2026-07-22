import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ProfileHeader, initialsOf } from "./ProfileHeader"

describe("ProfileHeader", () => {
  it("renders the name heading and subtitle", () => {
    render(<ProfileHeader user={{ name: "Dr. Smith" }} subtitle="Instructor · 3 courses" />)
    expect(screen.getByRole("heading", { name: "Dr. Smith" })).toBeInTheDocument()
    expect(screen.getByText("Instructor · 3 courses")).toBeInTheDocument()
  })
})

describe("initialsOf", () => {
  it("builds first+last initials from a 'Lastname, Firstname' name (matches the list avatars)", () => {
    // Regression: was returning display-order "LV" instead of "VL".
    expect(initialsOf("Lam, Vincent")).toBe("VL")
    expect(initialsOf("Van Der Berg, Mary")).toBe("MV")
  })

  it("uses the first letters of a plain 'First Last' name", () => {
    expect(initialsOf("Dr. Smith")).toBe("DS")
    expect(initialsOf("Ada")).toBe("A")
  })

  it("falls back to a single letter for an email, and '?' for an empty name", () => {
    expect(initialsOf("vincent.lam@ubc.ca")).toBe("V")
    expect(initialsOf("")).toBe("?")
  })
})
