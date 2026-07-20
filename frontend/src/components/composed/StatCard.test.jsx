import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { StatCard } from "./StatCard"

describe("StatCard", () => {
  it("renders the label and value", () => {
    render(<StatCard label="Messages" value={128} trend="+12 this week" />)
    expect(screen.getByText("Messages")).toBeInTheDocument()
    expect(screen.getByText("128")).toBeInTheDocument()
    expect(screen.getByText("+12 this week")).toBeInTheDocument()
  })
})
