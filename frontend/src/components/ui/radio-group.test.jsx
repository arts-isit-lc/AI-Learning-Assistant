import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { RadioGroup, RadioGroupItem } from "./radio-group"

describe("RadioGroup", () => {
  it("marks the default-selected option as checked", () => {
    render(
      <RadioGroup defaultValue="a">
        <RadioGroupItem value="a" aria-label="Option A" />
        <RadioGroupItem value="b" aria-label="Option B" />
      </RadioGroup>
    )
    expect(screen.getByRole("radio", { name: "Option A" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Option B" })).not.toBeChecked()
  })
})
