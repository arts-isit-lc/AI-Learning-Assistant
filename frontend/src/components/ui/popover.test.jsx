import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Popover, PopoverTrigger, PopoverContent } from "./popover"

describe("Popover", () => {
  it("shows its content when open", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Panel body</PopoverContent>
      </Popover>
    )
    expect(screen.getByText("Panel body")).toBeInTheDocument()
  })
})
