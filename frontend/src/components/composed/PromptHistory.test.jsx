import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PromptHistory } from "./PromptHistory"

const VERSIONS = [
  { previous_prompt: "newest version", timestamp: "2026-02-01T00:00:00Z" },
  { previous_prompt: "older version", timestamp: "2026-01-01T00:00:00Z" },
]

/** The whole card is the select control; grab it via its prompt text. */
const rowFor = (text) => screen.getByText(text).closest("button")

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

  it("reveals a 'Use prompt' button only after a row is selected", async () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} />)
    // Nothing to restore with until the user picks a version.
    expect(screen.queryByRole("button", { name: /use prompt/i })).not.toBeInTheDocument()
    await userEvent.click(rowFor("older version"))
    expect(screen.getByRole("button", { name: /use prompt/i })).toBeInTheDocument()
  })

  it("restores a version only when its 'Use prompt' button is clicked, not on row select", async () => {
    const onRestore = vi.fn()
    render(<PromptHistory versions={VERSIONS} onRestore={onRestore} />)
    await userEvent.click(rowFor("older version"))
    // Selecting a row must not overwrite the editor on its own.
    expect(onRestore).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: /use prompt/i }))
    expect(onRestore).toHaveBeenCalledWith("older version")
  })

  it("shows the action for only one version at a time", async () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} />)
    await userEvent.click(rowFor("older version"))
    expect(screen.getAllByRole("button", { name: /use prompt/i })).toHaveLength(1)
    // Picking a different version moves the action there — still exactly one.
    await userEvent.click(rowFor("newest version"))
    expect(screen.getAllByRole("button", { name: /use prompt/i })).toHaveLength(1)
  })

  it("toggles the action off when the selected row is clicked again", async () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} />)
    const row = rowFor("older version")
    await userEvent.click(row)
    expect(screen.getByRole("button", { name: /use prompt/i })).toBeInTheDocument()
    await userEvent.click(row)
    expect(screen.queryByRole("button", { name: /use prompt/i })).not.toBeInTheDocument()
  })

  it("tints the row with the lavender surface + primary border on hover and when selected", async () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} />)
    const row = rowFor("older version")
    // Transparent default border (no layout shift) + lavender hover surface, 4px radius.
    expect(row).toHaveClass("rounded-sm", "border-transparent", "hover:bg-primary-subtle", "hover:border-primary")
    // Selected → the Figma "Variant2" look: primary border + lavender fill.
    await userEvent.click(row)
    expect(row).toHaveClass("border-primary", "bg-primary-subtle")
  })

  it("separates entries with a horizontal divider when there is more than one", () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} />)
    // The first entry has no divider above it…
    expect(screen.getByText("newest version").closest("li")).not.toHaveClass("border-t")
    // …every later entry is split from the previous one by a top border.
    expect(screen.getByText("older version").closest("li")).toHaveClass("border-t", "border-border")
  })

  it("shows no divider when there is only one previous prompt", () => {
    render(<PromptHistory versions={[VERSIONS[0]]} onRestore={vi.fn()} />)
    expect(screen.getByText("newest version").closest("li")).not.toHaveClass("border-t")
  })

  it("disables the rows when disabled", () => {
    render(<PromptHistory versions={VERSIONS} onRestore={vi.fn()} disabled />)
    expect(rowFor("newest version")).toBeDisabled()
  })
})
