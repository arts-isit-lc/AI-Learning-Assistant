import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./select"

// Radix Select's open interaction relies on pointer-capture / scrollIntoView
// that jsdom lacks; the open menu is exercised in Playwright (Phase 5+). Here we
// verify the closed trigger renders as an accessible combobox.
describe("Select", () => {
  it("renders an accessible combobox trigger", () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger aria-label="Language model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Claude</SelectItem>
          <SelectItem value="b">Llama</SelectItem>
        </SelectContent>
      </Select>
    )
    expect(screen.getByRole("combobox", { name: "Language model" })).toBeInTheDocument()
  })
})
