import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { WizardStepper } from "./WizardStepper"

describe("WizardStepper", () => {
  it("renders each step and marks the current one", () => {
    render(<WizardStepper steps={["Details", "References", "Review"]} current={1} />)
    expect(screen.getByText("Details")).toBeInTheDocument()
    expect(screen.getByText("References")).toBeInTheDocument()
    expect(screen.getByText("Review")).toBeInTheDocument()
    expect(screen.getByText("References").closest("li")).toHaveAttribute("aria-current", "step")
  })
})
