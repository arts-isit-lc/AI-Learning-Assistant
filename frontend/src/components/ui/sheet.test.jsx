import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Sheet, SheetContent, SheetTitle } from "./sheet"

describe("Sheet", () => {
  it("renders a side panel dialog with an accessible name when open", () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Module materials</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Module materials")
  })

  it("shows the close X in #404040 (foreground), greying to the chevron hover colour on hover", () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Module materials</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    const close = screen.getByRole("button", { name: "Close" })
    // #404040 at rest; hover greys to neutral-400 (#BFBFBF) — matches the dropdown chevron.
    expect(close).toHaveClass("text-foreground", "hover:text-neutral-400")
    expect(close).not.toHaveClass("opacity-70")
  })
})
