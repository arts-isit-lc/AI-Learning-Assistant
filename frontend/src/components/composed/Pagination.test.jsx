import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Pagination } from "./Pagination"

describe("Pagination", () => {
  it("renders nothing when there is a single page", () => {
    const { container } = render(<Pagination page={0} pageCount={1} onPageChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("disables Previous on the first page and marks the current page", () => {
    render(<Pagination page={0} pageCount={5} onPageChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled()
    // aria-current flags the active page for assistive tech.
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page")
  })

  it("disables Next on the last page", () => {
    render(<Pagination page={4} pageCount={5} onPageChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled()
  })

  it("reports the target page (0-indexed) when a number is clicked", async () => {
    const onPageChange = vi.fn()
    render(<Pagination page={0} pageCount={5} onPageChange={onPageChange} />)
    await userEvent.click(screen.getByRole("button", { name: "Page 3" }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it("advances via Next and retreats via Previous", async () => {
    const onPageChange = vi.fn()
    render(<Pagination page={2} pageCount={5} onPageChange={onPageChange} />)
    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(onPageChange).toHaveBeenLastCalledWith(3)
    await userEvent.click(screen.getByRole("button", { name: "Previous" }))
    expect(onPageChange).toHaveBeenLastCalledWith(1)
  })

  it("slides the window so at most maxButtons numbers show, centred on the current page", () => {
    render(<Pagination page={5} pageCount={10} onPageChange={vi.fn()} maxButtons={5} />)
    // Window centres on page 6 (1-indexed): 4,5,6,7,8.
    expect(screen.getByRole("button", { name: "Page 4" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Page 8" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Page 3" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Page 9" })).not.toBeInTheDocument()
  })
})
