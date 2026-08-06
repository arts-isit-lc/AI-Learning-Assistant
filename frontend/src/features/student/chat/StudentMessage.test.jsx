import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StudentMessage } from "./StudentMessage"

describe("StudentMessage", () => {
  it("renders the message content", () => {
    render(<StudentMessage content="What is a map?" />)
    expect(screen.getByText("What is a map?")).toBeInTheDocument()
  })

  it("offers delete only on the most-recent message that has an AI reply after it", () => {
    const { rerender } = render(
      <StudentMessage content="q" isMostRecent hasAiMessageAfter={false} onDelete={() => {}} />
    )
    expect(screen.queryByRole("button", { name: /delete this message/i })).toBeNull()

    rerender(<StudentMessage content="q" isMostRecent hasAiMessageAfter onDelete={() => {}} />)
    expect(screen.getByRole("button", { name: /delete this message/i })).toBeInTheDocument()
  })

  it("fires onDelete", async () => {
    const onDelete = vi.fn()
    render(<StudentMessage content="q" isMostRecent hasAiMessageAfter onDelete={onDelete} />)
    await userEvent.click(screen.getByRole("button", { name: /delete this message/i }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it("styles the delete icon with the non-chevron state set: #6829C2 → #2E0666 hover → #000 pressed", () => {
    render(<StudentMessage content="q" isMostRecent hasAiMessageAfter onDelete={() => {}} />)
    const del = screen.getByRole("button", { name: /delete this message/i })
    expect(del).toHaveClass("text-primary", "hover:text-primary-dark", "active:text-neutral-900")
    // Colour-only per the icon rule — no hover background fill.
    expect(del).not.toHaveClass("hover:bg-muted")
  })
})
