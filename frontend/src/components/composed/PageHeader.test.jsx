import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { PageHeader } from "./PageHeader"

describe("PageHeader", () => {
  it("renders the title and an actions slot", () => {
    render(<PageHeader title="Courses" actions={<button type="button">New</button>} />)
    expect(screen.getByRole("heading", { level: 1, name: "Courses" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument()
  })
})
