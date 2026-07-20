import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ChatInput } from "./ChatInput"

describe("ChatInput", () => {
  it("submits the trimmed value on Enter", async () => {
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} />)
    await userEvent.type(screen.getByLabelText("Message AI Assistant"), "hello{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("hello")
  })

  it("inserts a newline (no submit) on Shift+Enter", async () => {
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} />)
    await userEvent.type(
      screen.getByLabelText("Message AI Assistant"),
      "line1{Shift>}{Enter}{/Shift}"
    )
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("does not submit when disabled", async () => {
    const onSubmit = vi.fn()
    render(<ChatInput onSubmit={onSubmit} disabled />)
    const box = screen.getByLabelText("Message AI Assistant")
    await userEvent.type(box, "hi{Enter}")
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled()
  })
})
