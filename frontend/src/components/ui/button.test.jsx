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
    const btn = screen.getByRole("button", { name: "Save" })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute("aria-busy", "true")
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
})
