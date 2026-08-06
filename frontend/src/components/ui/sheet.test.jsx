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

  it("shows the close X in the non-chevron icon state set: #6829C2 → #2E0666 hover → #000 pressed", () => {
    render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Module materials</SheetTitle>
        </SheetContent>
      </Sheet>
    )
    const close = screen.getByRole("button", { name: "Close" })
    // #6829C2 (primary) at rest, #2E0666 (primary-dark) on hover, #000 (neutral-900) pressed.
    expect(close).toHaveClass("text-primary", "hover:text-primary-dark", "active:text-neutral-900")
    expect(close).not.toHaveClass("text-foreground", "hover:text-neutral-400")
  })
})
