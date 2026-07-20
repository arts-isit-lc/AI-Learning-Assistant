import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { FormField } from "./FormField"
import { Input } from "@/components/ui/input"

describe("FormField", () => {
  it("associates the label with the control", () => {
    render(
      <FormField label="Email">
        <Input placeholder="you@example.com" />
      </FormField>
    )
    expect(screen.getByLabelText(/Email/)).toBe(screen.getByPlaceholderText("you@example.com"))
  })

  it("renders an inline error and marks the control invalid", () => {
    render(
      <FormField label="Email" error="Email is required">
        <Input placeholder="you@example.com" />
      </FormField>
    )
    expect(screen.getByText("Email is required")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("you@example.com")).toHaveAttribute("aria-invalid", "true")
  })
})
