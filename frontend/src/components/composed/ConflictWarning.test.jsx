import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ConflictWarning } from "./ConflictWarning"

describe("ConflictWarning", () => {
  it("renders the default conflict message as an alert", () => {
    render(<ConflictWarning />)
    expect(screen.getByRole("alert")).toHaveTextContent("There are conflicts. Please resolve below.")
  })

  it("uses the compact Figma banner scale (12px / 28px line-height) on a borderless red strip", () => {
    render(<ConflictWarning />)
    const banner = screen.getByRole("alert")
    expect(banner).toHaveClass("text-xs", "leading-7", "bg-destructive-muted", "text-destructive")
    // Not the generic bordered Alert callout.
    expect(banner).not.toHaveClass("border")
  })

  it("merges a caller className for spacing", () => {
    render(<ConflictWarning className="mt-3" />)
    expect(screen.getByRole("alert")).toHaveClass("mt-3")
  })
})
