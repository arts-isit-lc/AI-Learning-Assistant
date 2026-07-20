import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Input } from "./input"

describe("Input", () => {
  it("renders and forwards its value", () => {
    render(<Input placeholder="Email" defaultValue="a@b.c" />)
    expect(screen.getByPlaceholderText("Email")).toHaveValue("a@b.c")
  })

  it("supports the disabled state", () => {
    render(<Input placeholder="Email" disabled />)
    expect(screen.getByPlaceholderText("Email")).toBeDisabled()
  })

  it("reflects aria-invalid for the error state", () => {
    render(<Input placeholder="Email" aria-invalid="true" />)
    expect(screen.getByPlaceholderText("Email")).toHaveAttribute("aria-invalid", "true")
  })
})
