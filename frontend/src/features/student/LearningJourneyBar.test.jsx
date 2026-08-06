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

  it("renders concepts in a horizontal scrollable row when expanded", async () => {
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: /learning journey/i }))
    const list = screen.getByRole("link", { name: /week 1/i }).closest("ul").parentElement.closest("ul")
    expect(list).toHaveClass("flex")
    expect(list).not.toHaveClass("flex-col")
    expect(list).toHaveClass("overflow-x-auto")
  })

  it("marks a completed concept with a filled green check and numbers the rest", async () => {
    renderBar()
    await userEvent.click(screen.getByRole("button", { name: /learning journey/i }))

    // Completed concept (c1 "maps") → checkmark instead of an index number.
    const check = screen.getByRole("img", { name: /complete/i })
    const completeMarker = check.closest("span")
    expect(completeMarker).toHaveClass("bg-success", "text-success-foreground", "rounded-full")

    // Incomplete concept (c2 "water") → its 1-based index, outlined not filled.
    const incompleteMarker = screen.getByText("2")
    expect(incompleteMarker).toHaveClass("border", "border-neutral-900", "bg-transparent")
    expect(incompleteMarker).not.toHaveClass("bg-success")

    // Only the completed concept gets a check — index 1 is replaced by it.
    expect(screen.queryByText("1")).not.toBeInTheDocument()
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
