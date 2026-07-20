import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ListRow } from "./ListRow"

describe("ListRow", () => {
  it("is a button that fires onClick when interactive", async () => {
    const onClick = vi.fn()
    render(<ListRow onClick={onClick}>GEOG 250</ListRow>)
    const row = screen.getByRole("button", { name: "GEOG 250" })
    await userEvent.click(row)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("marks the selected row via aria-current", () => {
    render(
      <ListRow onClick={() => {}} selected>
        Active
      </ListRow>
    )
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-current", "true")
  })

  it("renders a non-interactive container without onClick", () => {
    render(<ListRow>Static</ListRow>)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("Static")).toBeInTheDocument()
  })
})
