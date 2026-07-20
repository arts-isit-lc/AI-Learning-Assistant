import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { Separator } from "./separator"

describe("Separator", () => {
  it("renders a decorative divider (hidden from the a11y tree)", () => {
    const { container } = render(<Separator />)
    const el = container.firstChild
    expect(el).toBeInTheDocument()
    // decorative separators are not exposed as a semantic separator
    expect(el).not.toHaveAttribute("role", "separator")
  })

  it("exposes a semantic separator when not decorative", () => {
    const { getByRole } = render(<Separator decorative={false} />)
    expect(getByRole("separator")).toBeInTheDocument()
  })
})
