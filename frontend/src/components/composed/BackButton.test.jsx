import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BackButton } from "./BackButton"

describe("BackButton", () => {
  it("fires onClick", async () => {
    const onClick = vi.fn()
    render(<BackButton onClick={onClick} />)
    await userEvent.click(screen.getByRole("button", { name: /back/i }))
    expect(onClick).toHaveBeenCalledOnce()
  })
})
