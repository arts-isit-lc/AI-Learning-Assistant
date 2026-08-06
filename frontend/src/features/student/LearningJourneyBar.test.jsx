import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { LearningJourneyBar } from "./LearningJourneyBar"

const concepts = [
  {
    concept_id: "c1",
    concept_name: "maps",
    isComplete: true,
    modules: [{ module_id: "m1", module_name: "week 1" }],
  },
  {
    concept_id: "c2",
    concept_name: "water",
    isComplete: false,
    modules: [{ module_id: "m2", module_name: "week 2" }],
  },
]

function renderBar(props) {
  return render(
    <MemoryRouter>
      <LearningJourneyBar
        concepts={concepts}
        completedConcepts={1}
        totalConcepts={2}
        percent={50}
        {...props}
      />
    </MemoryRouter>
  )
}

describe("LearningJourneyBar", () => {
  it("shows the label, status, and progress summary", () => {
    renderBar()
    expect(screen.getByText("Learning Journey")).toBeInTheDocument()
    expect(screen.getByText("IN PROGRESS")).toBeInTheDocument()
    expect(screen.getByText("50% (1/2 concepts completed)")).toBeInTheDocument()
  })

  it("skeletons the status/summary and disables the drawer toggle while loading", () => {
    renderBar({ loading: true })
    // Label stays; the "NOT STARTED · 0% (0/0)" summary is replaced by a
    // role=status skeleton so no stale progress flashes.
    expect(screen.getByText("Learning Journey")).toBeInTheDocument()
    expect(screen.getByRole("status", { name: /loading progress/i })).toBeInTheDocument()
    expect(screen.queryByText(/concepts completed/i)).not.toBeInTheDocument()
    // The tracker can't be opened onto an empty list while loading.
    expect(screen.getByRole("button", { name: /learning journey/i })).toBeDisabled()
  })

  it("toggles the concept-tracker drawer, exposing/hiding it from assistive tech", async () => {
    renderBar()
    const toggle = screen.getByRole("button", { name: /learning journey/i })

    // Collapsed by default: the drawer content is out of the a11y tree.
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("link", { name: /week 1/i })).not.toBeInTheDocument()

    // Open → concept module links become reachable.
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("link", { name: /week 1/i })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /week 2/i })).toBeInTheDocument()

    // Close → hidden again.
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("link", { name: /week 1/i })).not.toBeInTheDocument()
  })
})
