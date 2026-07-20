import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { AIMessage } from "./AIMessage"

describe("AIMessage", () => {
  it("renders plain content as markdown", () => {
    render(<AIMessage content="Hello there" />)
    expect(screen.getByText("Hello there")).toBeInTheDocument()
  })

  it("renders a structured table block", () => {
    render(
      <AIMessage
        blocks={[{ type: "table", headers: ["Term", "Definition"], rows: [["Map", "A drawing"]] }]}
      />
    )
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByText("Term")).toBeInTheDocument()
    expect(screen.getByText("Map")).toBeInTheDocument()
  })

  it("still shows content while streaming", () => {
    render(<AIMessage content="partial answer" isStreaming />)
    expect(screen.getByText("partial answer")).toBeInTheDocument()
  })
})
