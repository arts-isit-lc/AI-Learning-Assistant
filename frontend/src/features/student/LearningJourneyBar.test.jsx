import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"

import { LearningJourneyBar } from "./LearningJourneyBar"

const concepts = [
  {
    concept_id: "c1",
    concept_name: "introduction to water",
    isComplete: true,
    completedModules: 2,
    totalModules: 2,
    modules: [
      { module_id: "m1", module_name: "the hydrological cycle", module_score: 100 },
      { module_id: "m2", module_name: "drainage basin dynamics", module_score: 100 },
    ],
  },
  {
    concept_id: "c2",
    concept_name: "water security",
    isComplete: false,
    completedModules: 1,
    totalModules: 2,
    modules: [
      { module_id: "m3", module_name: "water quality", module_score: 100 },
      { module_id: "m4", module_name: "climate change and water", module_score: 0 },
    ],
  },
]

function renderBar(props = {}) {
  return render(
    <MemoryRouter initialEntries={["/courses/course-1"]}>
      <Routes>
        <Route
          path="/courses/:courseId"
          element={
            <LearningJourneyBar
              concepts={concepts}
              completedConcepts={1}
              totalConcepts={8}
              percent={25}
              {...props}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe("LearningJourneyBar", () => {
  it("renders the progress summary", () => {
    renderBar()
    expect(screen.getByText("Learning Journey")).toBeInTheDocument()
    expect(screen.getByText("IN PROGRESS")).toBeInTheDocument()
    expect(screen.getByText(/25% \(1\/8 concepts completed\)/)).toBeInTheDocument()
  })

  it("reflects the completion status from percent", () => {
    const { rerender } = renderBar({ percent: 100 })
    expect(screen.getByText("COMPLETED")).toBeInTheDocument()

    rerender(
      <MemoryRouter initialEntries={["/courses/course-1"]}>
        <Routes>
          <Route
            path="/courses/:courseId"
            element={
              <LearningJourneyBar concepts={concepts} completedConcepts={0} totalConcepts={8} percent={0} />
            }
          />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getByText("NOT STARTED")).toBeInTheDocument()
  })

  it("is collapsed by default (no concept or module detail shown)", () => {
    renderBar()
    const toggle = screen.getByRole("button", { name: /learning journey/i })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/water security/i)).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /hydrological cycle/i })).not.toBeInTheDocument()
  })

  it("expands to show each concept with its modules nested below it", async () => {
    renderBar()
    const toggle = screen.getByRole("button", { name: /learning journey/i })

    await userEvent.click(toggle)

    expect(toggle).toHaveAttribute("aria-expanded", "true")
    // Concept level.
    expect(screen.getByText(/introduction to water/i)).toBeInTheDocument()
    expect(screen.getByText(/water security/i)).toBeInTheDocument()

    // Modules nested under their concept, as links to the module chat.
    const firstModule = screen.getByRole("link", { name: /the hydrological cycle/i })
    expect(firstModule).toHaveAttribute("href", "/courses/course-1/modules/m1")
    expect(screen.getByRole("link", { name: /climate change and water/i })).toHaveAttribute(
      "href",
      "/courses/course-1/modules/m4"
    )
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
    expect(screen.getByRole("link", { name: /the hydrological cycle/i })).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("link", { name: /the hydrological cycle/i })).not.toBeInTheDocument()
  })
})
