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
})
