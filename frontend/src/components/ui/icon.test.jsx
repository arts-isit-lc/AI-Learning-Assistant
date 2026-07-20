import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MdHome } from "react-icons/md"
import { Icon } from "./icon"

describe("Icon", () => {
  it("renders the provided per-icon SVG", () => {
    const { container } = render(<Icon icon={MdHome} />)
    expect(container.querySelector("svg")).toBeInTheDocument()
  })

  it("is decorative by default (aria-hidden, no accessible name)", () => {
    const { container } = render(<Icon icon={MdHome} />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(svg).not.toHaveAttribute("aria-label")
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("exposes an accessible name when `label` is provided", () => {
    render(<Icon icon={MdHome} label="Home" />)
    const img = screen.getByRole("img", { name: "Home" })
    expect(img).toBeInTheDocument()
    expect(img).not.toHaveAttribute("aria-hidden")
  })

  it("applies the size to width/height and defaults to 20", () => {
    const { container, rerender } = render(<Icon icon={MdHome} />)
    let svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("width", "20")
    expect(svg).toHaveAttribute("height", "20")

    rerender(<Icon icon={MdHome} size={32} />)
    svg = container.querySelector("svg")
    expect(svg).toHaveAttribute("width", "32")
  })

  it("merges a token colour class onto the base classes", () => {
    const { container } = render(
      <Icon icon={MdHome} className="text-primary" />
    )
    const svg = container.querySelector("svg")
    expect(svg).toHaveClass("text-primary")
    expect(svg).toHaveClass("shrink-0")
  })

  it("renders nothing when no icon is supplied", () => {
    const { container } = render(<Icon />)
    expect(container.querySelector("svg")).toBeNull()
  })
})
