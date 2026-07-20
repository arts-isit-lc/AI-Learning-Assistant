import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Toggle } from "./toggle"

describe("Toggle", () => {
  it("flips on click (role switch)", async () => {
    render(<Toggle aria-label="OCELIA access" />)
    const sw = screen.getByRole("switch", { name: "OCELIA access" })
    expect(sw).toHaveAttribute("aria-checked", "false")
    await userEvent.click(sw)
    expect(sw).toHaveAttribute("aria-checked", "true")
  })

  it("supports the disabled state", () => {
    render(<Toggle aria-label="OCELIA access" disabled />)
    expect(screen.getByRole("switch", { name: "OCELIA access" })).toBeDisabled()
  })
})
