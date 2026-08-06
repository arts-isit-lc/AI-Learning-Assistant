import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MdAdd } from "react-icons/md"
import { Button } from "./button"
import { Icon } from "./icon"

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

  it("visually hides the label (sr-only) and shows the brand-purple (#6829C2) spinner surface while loading", () => {
    render(<Button loading>Save</Button>)
    // Accessible name is preserved (button still findable by name) ...
    const btn = screen.getByRole("button", { name: "Save" })
    // ... but the label is not visually shown — it lives in an sr-only span.
    const label = btn.querySelector("span.sr-only")
    expect(label).toHaveTextContent("Save")
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
    const btn = screen.getByRole("button", { name: "Save" })
    expect(btn).toBeDisabled()
    expect(btn).toHaveClass("bg-primary", "text-primary-foreground")
    // Label present only in the sr-only span, not shown visually.
    expect(btn.querySelector("span.sr-only")).toHaveTextContent("Save")
  })

  it("shows the label again once loading resolves", () => {
    const { rerender } = render(<Button loading>Save</Button>)
    // While loading the visible label is sr-only.
    expect(screen.getByRole("button", { name: "Save" }).querySelector("span.sr-only")).toHaveTextContent("Save")
    rerender(<Button>Save</Button>)
    const btn = screen.getByRole("button", { name: "Save" })
    expect(btn).toHaveTextContent("Save")
    expect(btn.querySelector("span.sr-only")).toBeNull()
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

  it("default variant (#6829C2 / white): hovers to #2E0666 and presses to #000, springing back to #6829C2", () => {
    render(<Button>Save</Button>)
    const btn = screen.getByRole("button", { name: "Save" })
    // Resting state is the brand purple with white text.
    expect(btn).toHaveClass("bg-primary", "text-primary-foreground")
    // Hover -> #2E0666 (primary-dark).
    expect(btn).toHaveClass("hover:bg-primary-dark")
    // Active/press -> #000 (neutral-900); no active override means it returns to
    // bg-primary once released.
    expect(btn).toHaveClass("active:bg-neutral-900")
  })

  it("applies the requested variant", () => {
    render(<Button variant="danger">Delete</Button>)
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-destructive")
  })

  it("ghostPrimary: #6829C2 text with no border/fill at rest; hovers to #F2E8FF/#2E0666 and presses to #AA78F0/#2E0666", () => {
    render(<Button variant="ghostPrimary">Add</Button>)
    const btn = screen.getByRole("button", { name: "Add" })
    // Rest: brand-purple text, no border, no background fill.
    expect(btn).toHaveClass("text-primary")
    expect(btn).not.toHaveClass("border")
    expect(btn).not.toHaveClass("bg-primary", "bg-primary-subtle", "bg-primary-active")
    // Hover: #F2E8FF (primary-subtle) surface + #2E0666 (primary-dark) text.
    expect(btn).toHaveClass("hover:bg-primary-subtle", "hover:text-primary-dark")
    // Press (active): #AA78F0 (primary-active) surface + #2E0666 text; no active
    // override elsewhere means it springs back to the resting state on release.
    expect(btn).toHaveClass("active:bg-primary-active", "active:text-primary-dark")
  })

  it("gives the outline variant (every modal Cancel button) the #F2E8FF hover (hover:bg-primary-subtle)", () => {
    render(<Button variant="outline">Cancel</Button>)
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("hover:bg-primary-subtle")
  })

  it("outline: #6829C2 border+text at rest; hover darkens border+text to #2E0666; press paints #AA78F0 with #2E0666 border+text", () => {
    render(<Button variant="outline">Add</Button>)
    const btn = screen.getByRole("button", { name: "Add" })
    // Rest: #6829C2 (primary) border + text on a white (bg-background) fill.
    expect(btn).toHaveClass("border", "border-primary", "bg-background", "text-primary")
    // Hover: #F2E8FF (primary-subtle) surface + #2E0666 (primary-dark) border AND text.
    expect(btn).toHaveClass("hover:bg-primary-subtle", "hover:border-primary-dark", "hover:text-primary-dark")
    // Press (active): #AA78F0 (primary-active) surface + #2E0666 border AND text.
    expect(btn).toHaveClass("active:bg-primary-active", "active:border-primary-dark", "active:text-primary-dark")
  })

  it("outline disabled (inactive): #BFBFBF (neutral-400) border+text on the white fill, no opacity fade", () => {
    render(
      <Button variant="outline" disabled>
        Cancel
      </Button>
    )
    const btn = screen.getByRole("button", { name: "Cancel" })
    expect(btn).toHaveClass("bg-background", "disabled:border-neutral-400", "disabled:text-neutral-400", "disabled:opacity-100")
  })

  it("lets an Icon inside an outline button track the text colour via currentColor", () => {
    // The Icon primitive paints with currentColor (no colour of its own), so it
    // follows the button's text through the hover/active transitions rather than
    // pinning a fixed colour.
    render(
      <Button variant="outline">
        Add <Icon icon={MdAdd} label="add" />
      </Button>
    )
    const svg = screen.getByRole("img", { name: "add" })
    expect(svg).not.toHaveClass("text-primary", "text-primary-dark")
    expect(svg.getAttribute("fill")).toBe("currentColor")
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
