import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { Breadcrumb } from "./Breadcrumb"

describe("Breadcrumb", () => {
  it("links intermediate crumbs and marks the last as the current page", () => {
    render(
      <MemoryRouter>
        <Breadcrumb
          items={[
            { label: "Courses", to: "/courses" },
            { label: "GEOG 250", to: "/courses/1" },
            { label: "Week 1" },
          ]}
        />
      </MemoryRouter>
    )
    expect(screen.getByRole("link", { name: "Courses" })).toBeInTheDocument()
    const current = screen.getByText("Week 1")
    expect(current).toHaveAttribute("aria-current", "page")
    expect(screen.queryByRole("link", { name: "Week 1" })).toBeNull()
  })
})
