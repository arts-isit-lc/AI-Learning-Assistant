import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "./button"

describe("Button", () => {
  it("fires onClick when enabled", async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Save</Button>)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("is disabled and marked busy while loading", () => {
    render(<Button loading>Save</Button>)
    const btn = screen.getByRole("button")
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("aria-busy", "true")
  })

  it("hides the label and shows the brand-purple (#6829C2) spinner surface while loading", () => {
    render(<Button loading>Save</Button>)
    const btn = screen.getByRole("button")
    // Label is hidden for the duration of the animation.
    expect(btn).not.toHaveTextContent("Save")
    // #6829C2 == bg-primary, with a white (text-primary-foreground) spinner.
    expect(btn).toHaveClass("bg-primary", "text-primary-foreground")
    // Spinner element present.
    expect(btn.querySelector(".animate-spin")).toBeInTheDocument()
  })

  it("keeps full opacity while loading (no disabled fade)", () => {
    render(<Button loading>Save</Button>)
    const btn = screen.getByRole("button")
    // Disabled while loading, but the fade is suppressed so the surface stays solid.
    expect(btn).toHaveClass("disabled:opacity-100")
  })

  it("forces the brand-purple loading surface even on a non-default variant", () => {
    render(
      <Button loading variant="outline">
        Save
      </Button>
    )
    const btn = screen.getByRole("button")
    expect(btn).toBeDisabled()
    expect(btn).toHaveClass("bg-primary", "text-primary-foreground")
    expect(btn).not.toHaveTextContent("Save")
  })

  it("shows the label again once loading resolves", () => {
    const { rerender } = render(<Button loading>Save</Button>)
    expect(screen.getByRole("button")).not.toHaveTextContent("Save")
    rerender(<Button>Save</Button>)
    const btn = screen.getByRole("button", { name: "Save" })
    expect(btn).toHaveTextContent("Save")
    expect(btn).not.toBeDisabled()
  })

  it("respects the disabled prop", () => {
    render(<Button disabled>Save</Button>)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("renders styles onto a child element with asChild", () => {
    render(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>
    )
    expect(screen.getByRole("link", { name: "Go" })).toBeInTheDocument()
  })

  it("applies the requested variant", () => {
    render(<Button variant="danger">Delete</Button>)
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-destructive")
  })

  it("gives the outline variant (every modal Cancel button) the #F2E8FF hover (hover:bg-primary-subtle)", () => {
    render(<Button variant="outline">Cancel</Button>)
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("hover:bg-primary-subtle")
  })

  it("greys a disabled outline button with the #BFBFBF (neutral-400) token, not the opacity fade", () => {
    render(
      <Button variant="outline" disabled>
        Add module
      </Button>
    )
    const btn = screen.getByRole("button", { name: "Add module" })
    expect(btn).toHaveClass("disabled:border-neutral-400")
    expect(btn).toHaveClass("disabled:text-neutral-400")
    expect(btn).toHaveClass("disabled:opacity-100")
    expect(btn).not.toHaveClass("disabled:opacity-50")
  })

  it("keeps the default opacity fade for non-outline disabled buttons (change is scoped to outline)", () => {
    render(<Button disabled>Save</Button>)
    const btn = screen.getByRole("button", { name: "Save" })
    expect(btn).toHaveClass("disabled:opacity-50")
    expect(btn).not.toHaveClass("disabled:border-neutral-400")
  })
})
