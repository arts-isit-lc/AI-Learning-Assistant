import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import StyleGuide from "./StyleGuide"

describe("StyleGuide token preview", () => {
  it("renders the main heading", () => {
    render(<StyleGuide />)
    expect(
      screen.getByRole("heading", { level: 1, name: /OCELIA design tokens/i })
    ).toBeInTheDocument()
  })

  it("renders a section heading for every token category", () => {
    render(<StyleGuide />)
    for (const title of [
      /Colour/i,
      /Typography/i,
      /Spacing/i,
      /Radius/i,
      /Shadow/i,
      /Motion/i,
      /Z-index/i,
      /Icons/i,
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument()
    }
  })

  it("labels the semantic colour swatches", () => {
    render(<StyleGuide />)
    expect(screen.getByText("primary")).toBeInTheDocument()
    expect(screen.getByText("destructive-muted")).toBeInTheDocument()
    expect(screen.getByText("success")).toBeInTheDocument()
  })

  it("renders labelled Material icons via the Icon primitive", () => {
    render(<StyleGuide />)
    expect(screen.getByRole("img", { name: "Home" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Warning" })).toBeInTheDocument()
  })
})
