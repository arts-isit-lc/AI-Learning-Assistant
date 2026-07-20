import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ScrollArea } from "./scroll-area"

describe("ScrollArea", () => {
  it("renders its content inside the viewport", () => {
    render(
      <ScrollArea className="h-20">
        <p>Scrollable content</p>
      </ScrollArea>
    )
    expect(screen.getByText("Scrollable content")).toBeInTheDocument()
  })
})
