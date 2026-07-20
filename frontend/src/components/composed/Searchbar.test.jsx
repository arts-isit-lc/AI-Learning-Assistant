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
})
