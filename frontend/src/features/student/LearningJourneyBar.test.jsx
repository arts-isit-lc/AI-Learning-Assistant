import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LearningJourneyBar } from "./LearningJourneyBar"

const concepts = [
  {
    concept_id: "c1",
    concept_name: "introduction to water",
    isComplete: true,
    completedModules: 3,
    totalModules: 3,
    modules: [],
  },
  {
    concept_id: "c2",
    concept_name: "water security",
    isComplete: false,
    completedModules: 1,
    totalModules: 3,
    modules: [],
  },
]

function renderBar(props = {}) {
  return render(
    <LearningJourneyBar
      concepts={concepts}
      completedConcepts={2}
      totalConcepts={8}
      percent={25}
      {...props}
    />
  )
}

describe("LearningJourneyBar", () => {
  it("renders the progress summary", () => {
    renderBar()
    expect(screen.getByText("Learning Journey")).toBeInTheDocument()
    expect(screen.getByText("IN PROGRESS")).toBeInTheDocument()
    expect(screen.getByText(/25% \(2\/8 concepts completed\)/)).toBeInTheDocument()
  })

  it("reflects the completion status from percent", () => {
    const { rerender } = renderBar({ percent: 100 })
    expect(screen.getByText("COMPLETED")).toBeInTheDocument()

    rerender(
      <LearningJourneyBar concepts={concepts} completedConcepts={0} totalConcepts={8} percent={0} />
    )
    expect(screen.getByText("NOT STARTED")).toBeInTheDocument()
  })

  it("is collapsed by default (no concept detail shown)", () => {
    renderBar()
    const toggle = screen.getByRole("button", { name: /learning journey/i })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/modules complete/i)).not.toBeInTheDocument()
  })

  it("expands the per-concept progress inline when the trigger is clicked", async () => {
    renderBar()
    const toggle = screen.getByRole("button", { name: /learning journey/i })

    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    // Concept rows now render inline, right below the bar.
    expect(screen.getByText(/water security/i)).toBeInTheDocument()
    expect(screen.getByText(/3\/3 modules complete/)).toBeInTheDocument()
    expect(screen.getByText(/1\/3 modules complete/)).toBeInTheDocument()
    // Completed concept shows the check marker.
    expect(screen.getByRole("img", { name: "Complete" })).toBeInTheDocument()
  })

  it("expands inline rather than opening a right-side dialog/drawer", async () => {
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: /learning journey/i }))
    // The old behavior opened a Sheet (role="dialog"); the fix must not.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("collapses again on a second click", async () => {
    renderBar()
    const toggle = screen.getByRole("button", { name: /learning journey/i })

    await userEvent.click(toggle)
    expect(screen.getByText(/1\/3 modules complete/)).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/modules complete/i)).not.toBeInTheDocument()
  })
})
