import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect } from "vitest"
import { ProgressPopover } from "./ProgressPopover"

describe("ProgressPopover", () => {
  it("explains the empty state when sessionState is null", async () => {
    const user = userEvent.setup()
    render(<ProgressPopover sessionState={null} />)
    await user.click(screen.getByRole("button", { name: /module progress/i }))
    expect(screen.getByText(/no progress data for this turn yet/i)).toBeInTheDocument()
  })

  it("shows completion gates when popover is opened", async () => {
    const user = userEvent.setup()
    const state = {
      module_complete: false,
      interactions: 7,
      engagement_score: 0.6,
      concepts_discussed_count: 1,
      module_concepts_count: 5,
      required_concepts: 3,
      missing_requirements: ["concept_coverage"],
      stage: "comprehension",
    }

    render(<ProgressPopover sessionState={state} />)
    await user.click(screen.getByRole("button", { name: /module progress/i }))

    expect(screen.getByText("Module Progress")).toBeInTheDocument()
    expect(screen.getByText("7 / 5 minimum")).toBeInTheDocument()
    expect(screen.getByText(/1 \/ 3 topics discussed/)).toBeInTheDocument()
    expect(screen.getByText("60% (50% required)")).toBeInTheDocument()
    expect(screen.getByText(/comprehension/i)).toBeInTheDocument()
  })

  it("marks all gates as met when module is complete", async () => {
    const user = userEvent.setup()
    const state = {
      module_complete: true,
      interactions: 10,
      engagement_score: 1.0,
      concepts_discussed_count: 3,
      module_concepts_count: 5,
      required_concepts: 3,
      missing_requirements: [],
      stage: "mastery",
    }

    render(<ProgressPopover sessionState={state} />)
    await user.click(screen.getByRole("button", { name: /module progress/i }))

    expect(screen.getByText("Complete")).toBeInTheDocument()
    // All checkmarks rendered (Unicode check), no crosses
    const gates = screen.getAllByText("\u2713")
    expect(gates).toHaveLength(3)
  })

  it("shows the correct unmet gate indicators", async () => {
    const user = userEvent.setup()
    const state = {
      module_complete: false,
      interactions: 2,
      engagement_score: 0.2,
      concepts_discussed_count: 0,
      module_concepts_count: 4,
      required_concepts: 2,
      missing_requirements: ["interactions", "concept_coverage", "engagement"],
      stage: "prior_knowledge",
    }

    render(<ProgressPopover sessionState={state} />)
    await user.click(screen.getByRole("button", { name: /module progress/i }))

    // All crosses rendered (Unicode cross)
    const crosses = screen.getAllByText("\u2717")
    expect(crosses).toHaveLength(3)
    expect(screen.getByText("2 / 5 minimum")).toBeInTheDocument()
    expect(screen.getByText(/0 \/ 2 topics discussed/)).toBeInTheDocument()
    expect(screen.getByText("20% (50% required)")).toBeInTheDocument()
  })
})
