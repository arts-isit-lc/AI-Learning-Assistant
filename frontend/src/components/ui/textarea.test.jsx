import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Textarea } from "./textarea"

describe("Textarea", () => {
  it("renders and forwards its value", () => {
    render(<Textarea placeholder="Prompt" defaultValue="hello" />)
    expect(screen.getByPlaceholderText("Prompt")).toHaveValue("hello")
  })

  it("supports the disabled state", () => {
    render(<Textarea placeholder="Prompt" disabled />)
    expect(screen.getByPlaceholderText("Prompt")).toBeDisabled()
  })

  it("turns the border #6829C2 (primary) on focus, staying red when invalid", () => {
    render(<Textarea placeholder="Prompt" />)
    const textarea = screen.getByPlaceholderText("Prompt")
    // Clicking/focusing the field turns the border brand purple and thickens it to 2px.
    expect(textarea).toHaveClass("focus:border-primary", "focus:border-2")
    // An invalid field keeps its destructive border even while focused.
    expect(textarea).toHaveClass("aria-[invalid=true]:focus:border-destructive")
  })
})
