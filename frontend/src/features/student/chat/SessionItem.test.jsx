import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionItem } from "./SessionItem"

const session = { session_id: "s1", session_name: "Week 1 questions" }

describe("SessionItem", () => {
  it("selects on click", async () => {
    const onSelect = vi.fn()
    render(<SessionItem session={session} onSelect={onSelect} />)
    await userEvent.click(screen.getByRole("button", { name: /Week 1 questions/ }))
    expect(onSelect).toHaveBeenCalledWith(session)
  })

  it("deletes via the delete control", async () => {
    const onDelete = vi.fn()
    render(<SessionItem session={session} onDelete={onDelete} />)
    await userEvent.click(screen.getByRole("button", { name: /Delete chat/ }))
    expect(onDelete).toHaveBeenCalledWith(session)
  })

  it("marks the active session via aria-current", () => {
    render(<SessionItem session={session} isActive onSelect={() => {}} />)
    expect(screen.getByRole("button", { name: /Week 1 questions/ })).toHaveAttribute(
      "aria-current",
      "true"
    )
  })
})
