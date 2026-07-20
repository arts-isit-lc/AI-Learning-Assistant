import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Tag } from "./Tag"

describe("Tag", () => {
  it("renders its label", () => {
    render(<Tag label="Photosynthesis" />)
    expect(screen.getByText("Photosynthesis")).toBeInTheDocument()
  })

  it("fires onRemove from the dismiss button", async () => {
    const onRemove = vi.fn()
    render(<Tag label="Photosynthesis" onRemove={onRemove} />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Photosynthesis" }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})
