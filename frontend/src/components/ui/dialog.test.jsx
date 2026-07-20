import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog"

describe("Dialog", () => {
  it("renders content with an accessible name and a close control when open", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogContent>
      </Dialog>
    )
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Confirm")
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
  })
})
