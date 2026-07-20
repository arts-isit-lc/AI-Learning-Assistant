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
})
