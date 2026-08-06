import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./dialog"

const overlays = () => document.querySelectorAll("[data-dialog-overlay]")

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

  it("shows the close X in the non-chevron icon state set: #6829C2 → #2E0666 hover → #000 pressed", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const close = screen.getByRole("button", { name: "Close" })
    // #6829C2 (primary) at rest, #2E0666 (primary-dark) on hover, #000 (neutral-900) pressed.
    expect(close).toHaveClass("text-primary", "hover:text-primary-dark", "active:text-neutral-900")
    expect(close).not.toHaveClass("text-foreground", "hover:text-neutral-400")
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

  it("caps the content at 85vh so a modal can never exceed the screen", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Confirm</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    // Column layout + max-h-[85vh] is what lets a DialogBody scroll while the
    // header/footer stay pinned (see the body test below).
    expect(screen.getByRole("dialog")).toHaveClass("flex", "flex-col", "max-h-[85vh]")
  })

  it("pins the header and footer (shrink-0) and makes the body the scroll region", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm</DialogTitle>
          </DialogHeader>
          <DialogBody data-testid="body">
            <p>Lots of content</p>
          </DialogBody>
          <DialogFooter>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
    // Header/footer don't compress when the body overflows...
    expect(screen.getByText("Confirm").parentElement).toHaveClass("shrink-0")
    expect(screen.getByText("Save").parentElement).toHaveClass("shrink-0")
    // ...and the body takes the leftover height and scrolls its own overflow.
    expect(screen.getByTestId("body")).toHaveClass("flex-1", "min-h-0", "overflow-y-auto")
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

  it("recedes a lower modal when a second modal stacks over it, and restores it when the top closes", () => {
    // A form modal (always open) plus a confirmation modal that opens over it —
    // the CourseWizard / EditModule "discard?" pattern.
    function Stacked({ confirmOpen }) {
      return (
        <>
          <Dialog open>
            <DialogContent data-testid="form">
              <DialogTitle>Form</DialogTitle>
            </DialogContent>
          </Dialog>
          <Dialog open={confirmOpen}>
            <DialogContent data-testid="confirm">
              <DialogTitle>Confirm</DialogTitle>
            </DialogContent>
          </Dialog>
        </>
      )
    }

    const { rerender } = render(<Stacked confirmOpen={false} />)
    // Alone, the form is the top modal: full z-modal, its own backdrop visible.
    expect(screen.getByTestId("form")).toHaveClass("z-modal")
    expect(screen.getByTestId("form")).not.toHaveClass("z-sticky")
    expect(overlays()).toHaveLength(1)
    expect(overlays()[0]).not.toHaveClass("opacity-0")

    // Open the confirmation on top → the form recedes below the overlay layer
    // (z-sticky, not z-modal) and hides its own backdrop; the confirm is the
    // active top modal and provides the single dimming overlay.
    rerender(<Stacked confirmOpen={true} />)
    expect(screen.getByTestId("form")).toHaveClass("z-sticky")
    expect(screen.getByTestId("form")).not.toHaveClass("z-modal")
    expect(screen.getByTestId("confirm")).toHaveClass("z-modal")
    expect(screen.getByTestId("confirm")).not.toHaveClass("z-sticky")
    expect(overlays()).toHaveLength(2)
    // Portals mount in open order: form's backdrop is hidden, confirm's dims.
    expect(overlays()[0]).toHaveClass("opacity-0")
    expect(overlays()[1]).not.toHaveClass("opacity-0")

    // Cancel/close the confirmation → the form is top again and fully visible.
    rerender(<Stacked confirmOpen={false} />)
    expect(screen.getByTestId("form")).toHaveClass("z-modal")
    expect(screen.getByTestId("form")).not.toHaveClass("z-sticky")
    expect(overlays()).toHaveLength(1)
    expect(overlays()[0]).not.toHaveClass("opacity-0")
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
