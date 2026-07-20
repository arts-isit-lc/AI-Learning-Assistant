import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Command, CommandInput, CommandList, CommandItem } from "./command"

describe("Command", () => {
  it("renders a search input and its items", () => {
    render(
      <Command label="Command menu">
        <CommandInput placeholder="Search courses" />
        <CommandList>
          <CommandItem>Alpha</CommandItem>
          <CommandItem>Beta</CommandItem>
        </CommandList>
      </Command>
    )
    expect(screen.getByPlaceholderText("Search courses")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
  })
})
