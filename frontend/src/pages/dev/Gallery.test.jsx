import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import Gallery from "./Gallery"

describe("Gallery", () => {
  it("renders the component gallery with its section headings", () => {
    render(
      <MemoryRouter>
        <Gallery />
      </MemoryRouter>
    )
    expect(
      screen.getByRole("heading", { level: 1, name: /component gallery/i })
    ).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /^Button/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /Overlays/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /Form controls/ })).toBeInTheDocument()
  })
})
