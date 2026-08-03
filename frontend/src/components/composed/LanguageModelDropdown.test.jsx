import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { LanguageModelDropdown } from "./LanguageModelDropdown"

describe("LanguageModelDropdown", () => {
  it("renders an accessible model combobox", () => {
    render(
      <LanguageModelDropdown
        aria-label="Model"
        value="a"
        models={[
          { id: "a", name: "Claude Sonnet 4.5" },
          { id: "b", name: "Llama 3 70B" },
        ]}
      />
    )
    expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument()
  })

  it("disables the trigger when disabled", () => {
    render(
      <LanguageModelDropdown
        aria-label="Model"
        value="a"
        disabled
        models={[{ id: "a", name: "Claude Sonnet 4.5" }]}
      />
    )
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled()
  })
})
