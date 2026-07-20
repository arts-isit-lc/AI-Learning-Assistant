import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PromptHistory } from "./PromptHistory"

const VERSIONS = [
  { previous_prompt: "newest version", timestamp: "2026-02-01T00:00:00Z" },
  { previous_prompt: "older version", timestamp: "2026-01-01T00:00:00Z" },
]

describe("PromptHistory", () => {
  it("shows an empty message when there are no versions", () => {
    render(<PromptHistory versions={[]} />)
    expect(screen.getByText("No previous versions yet.")).toBeInTheDocument()
  })

  it("steps between versions", async () => {
    render(<PromptHistory versions={VERSIONS} />)
    expect(screen.getByText("newest version")).toBeInTheDocument()
    expect(screen.getByText("Version 1 of 2")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Next version" }))
    expect(screen.getByText("older version")).toBeInTheDocument()
    expect(screen.getByText("Version 2 of 2")).toBeInTheDocument()
  })

  it("restores the current version", async () => {
    const onRestore = vi.fn()
    render(<PromptHistory versions={VERSIONS} onRestore={onRestore} />)
    await userEvent.click(screen.getByRole("button", { name: "Restore" }))
    expect(onRestore).toHaveBeenCalledWith("newest version")
  })
})
