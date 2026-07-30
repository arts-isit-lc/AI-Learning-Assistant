import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./dialog"

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

  it("applies the standard modal padding (36px sides/bottom, 56px top) and 32px section rhythm", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const content = screen.getByRole("dialog")
    expect(content).toHaveClass("px-9", "pb-9", "pt-14", "gap-8")
  })

  it("gives the header a title-over-divider and the footer a divider-over-actions by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
    // Header: title over a full-width bottom divider, 8px between them.
    expect(screen.getByText("Confirm").parentElement).toHaveClass("border-b", "border-border", "pb-2")
    // Footer: full-width divider over the action row (16px), actions sized to the
    // Figma 16px (text-base) via the footer, not per-button overrides.
    expect(screen.getByText("Save").parentElement).toHaveClass(
      "border-t",
      "border-border",
      "pt-4",
      "[&>button]:text-base"
    )
  })

  it("renders the description as body-weight foreground text (Figma modal body)", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
          <DialogDescription>Are you sure?</DialogDescription>
        </DialogContent>
      </Dialog>
    )
    expect(screen.getByText("Are you sure?")).toHaveClass("text-body", "text-foreground")
  })
})
