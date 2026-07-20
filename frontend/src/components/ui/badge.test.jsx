import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Badge } from "./badge"

describe("Badge", () => {
  it("renders its label", () => {
    render(<Badge>Active</Badge>)
    expect(screen.getByText("Active")).toBeInTheDocument()
  })

  it("applies a semantic variant", () => {
    render(<Badge variant="success">Complete</Badge>)
    expect(screen.getByText("Complete")).toHaveClass("bg-success")
  })
})
