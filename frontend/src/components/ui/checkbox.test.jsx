import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Checkbox } from "./checkbox"

describe("Checkbox", () => {
  it("toggles checked state on click", async () => {
    render(<Checkbox aria-label="Select row" />)
    const cb = screen.getByRole("checkbox", { name: "Select row" })
    expect(cb).toHaveAttribute("aria-checked", "false")
    await userEvent.click(cb)
    expect(cb).toHaveAttribute("aria-checked", "true")
  })

  it("supports the disabled state", () => {
    render(<Checkbox aria-label="Select row" disabled />)
    expect(screen.getByRole("checkbox", { name: "Select row" })).toBeDisabled()
  })
})
