import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Searchbar } from "./Searchbar"

describe("Searchbar", () => {
  it("debounces and reports the final value", async () => {
    const onChange = vi.fn()
    render(<Searchbar onChange={onChange} debounceMs={30} />)
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "geo")
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("geo"))
  })

  it("shows the clear 'x' only once there's text, in the #6829C2→#2E0666→#000 state set", async () => {
    render(<Searchbar onChange={vi.fn()} debounceMs={30} />)
    // Empty field: no clear button yet.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull()

    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "geo")
    const clear = screen.getByRole("button", { name: "Clear search" })
    // Default #6829C2 (primary), hover #2E0666 (primary-dark), press #000 (neutral-900).
    expect(clear).toHaveClass("text-primary", "hover:text-primary-dark", "active:text-neutral-900")
  })

  it("clears the field immediately on click and hides the 'x' until the user types again", async () => {
    const onChange = vi.fn()
    render(<Searchbar onChange={onChange} debounceMs={30} />)
    const input = screen.getByRole("searchbox", { name: "Search" })

    await userEvent.type(input, "geo")
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }))
    // Field emptied immediately (no debounce wait) and reports "".
    expect(input).toHaveValue("")
    expect(onChange).toHaveBeenLastCalledWith("")
    // The 'x' disappears until there's text again.
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull()

    await userEvent.type(input, "phys")
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument()
  })
})
