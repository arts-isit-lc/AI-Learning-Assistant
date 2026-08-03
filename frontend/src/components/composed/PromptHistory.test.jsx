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

  it("lists every previous version's prompt text", () => {
    render(<PromptHistory versions={VERSIONS} />)
    expect(screen.getByText("newest version")).toBeInTheDocument()
    expect(screen.getByText("older version")).toBeInTheDocument()
  })

  it("restores a version when its row is clicked", async () => {
    const onRestore = vi.fn()
    render(<PromptHistory versions={VERSIONS} onRestore={onRestore} />)
    // The whole entry is the restore control (no separate Restore button).
    await userEvent.click(screen.getByText("older version").closest("button"))
    expect(onRestore).toHaveBeenCalledWith("older version")
  })

  it("disables the entries when disabled", () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} disabled />)
    expect(screen.getByText("newest version").closest("button")).toBeDisabled()
  })
})
