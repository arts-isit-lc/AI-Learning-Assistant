import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./select"

// The pointer-capture / scrollIntoView APIs Radix Select needs are polyfilled in
// src/test/setup.js, so we can render the OPEN menu here to assert the option
// surface (square rows + the #F2E8FF hover tint). Full pointer/keyboard highlight
// navigation + the chevron rotate-on-open are still exercised in Playwright.
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

  it("turns the trigger border #6829C2 (primary) on focus/open, with no chevron hover greying", () => {
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
    // Border becomes brand purple AND thickens to 2px on focus (click) and while the menu is open.
    expect(trigger).toHaveClass(
      "focus:border-primary",
      "focus:border-2",
      "data-[state=open]:border-primary",
      "data-[state=open]:border-2"
    )
    // The old hover-greying of the chevron is gone.
    expect(trigger.querySelector("svg")).not.toHaveClass("group-hover:text-neutral-400")
  })

  it("gives open options a square, #F2E8FF (primary-subtle) hover surface", async () => {
    render(
      <Select defaultOpen defaultValue="a">
        <SelectTrigger aria-label="Language model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Claude</SelectItem>
          <SelectItem value="b">Llama</SelectItem>
        </SelectContent>
      </Select>
    )
    const option = await screen.findByRole("option", { name: "Llama" })
    // #F2E8FF == the primary-subtle token; applied on both pointer-hover (focus)
    // and keyboard highlight (data-highlighted). Square, not rounded.
    expect(option).toHaveClass("focus:bg-primary-subtle")
    expect(option).toHaveClass("data-[highlighted]:bg-primary-subtle")
    expect(option).toHaveClass("rounded-none")
    expect(option).not.toHaveClass("focus:bg-accent")
  })

  it("bolds the selected option with no checkmark when the menu is reopened", async () => {
    render(
      <Select defaultOpen defaultValue="a">
        <SelectTrigger aria-label="Language model">
          <SelectValue placeholder="Choose a model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Claude</SelectItem>
          <SelectItem value="b">Llama</SelectItem>
        </SelectContent>
      </Select>
    )
    const selected = await screen.findByRole("option", { name: "Claude" })
    // Radix marks the chosen option data-state=checked; it renders bold (semibold)…
    expect(selected).toHaveAttribute("data-state", "checked")
    expect(selected).toHaveClass("data-[state=checked]:font-semibold")
    // …and there's no checkmark icon inside the option anymore.
    expect(selected.querySelector("svg")).toBeNull()
    // The unselected option is not marked checked.
    expect(screen.getByRole("option", { name: "Llama" })).toHaveAttribute("data-state", "unchecked")
  })
})
