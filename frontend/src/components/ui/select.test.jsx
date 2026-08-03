import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./select"

// Radix Select's open interaction relies on pointer-capture / scrollIntoView
// that jsdom lacks; the open menu (option alignment + the chevron that rotates
// up on open) is exercised in Playwright (Phase 5+). Here we verify the closed
// trigger renders as an accessible combobox and reflects the selected value.
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

  it("shows the selected option's label in the trigger", () => {
    render(
      <Select defaultValue="b">
        <SelectTrigger aria-label="Language model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Claude</SelectItem>
          <SelectItem value="b">Llama</SelectItem>
        </SelectContent>
      </Select>
    )
    expect(screen.getByRole("combobox", { name: "Language model" })).toHaveTextContent("Llama")
  })

  it("greys the trigger chevron on hover (group-hover:text-neutral-400)", () => {
    render(
      <Select defaultValue="a">
        <SelectTrigger aria-label="Language model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Claude</SelectItem>
        </SelectContent>
      </Select>
    )
    const trigger = screen.getByRole("combobox", { name: "Language model" })
    expect(trigger).toHaveClass("group")
    expect(trigger.querySelector("svg")).toHaveClass("group-hover:text-neutral-400")
  })
})
