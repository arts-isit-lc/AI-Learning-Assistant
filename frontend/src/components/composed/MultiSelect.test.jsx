import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MultiSelect } from "./MultiSelect"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

const OPTIONS = [
  { value: "a@x.com", label: "Alpha" },
  { value: "b@x.com", label: "Beta" },
]

describe("MultiSelect", () => {
  it("shows the placeholder when nothing is selected", () => {
    render(
      <MultiSelect options={OPTIONS} value={[]} onChange={() => {}} placeholder="Pick some" aria-label="Picker" />
    )
    expect(screen.getByRole("button", { name: "Picker" })).toHaveTextContent("Pick some")
  })

  it("turns the trigger border #6829C2 (primary) on focus/open, with no chevron hover greying", () => {
    render(<MultiSelect options={OPTIONS} value={[]} onChange={() => {}} aria-label="Picker" />)
    const trigger = screen.getByRole("button", { name: "Picker" })
    // Border becomes brand purple on focus (click) and while the menu is open.
    expect(trigger).toHaveClass("focus:border-primary", "data-[state=open]:border-primary")
    // The old hover-greying of the chevron is gone (and the now-unused group marker removed).
    expect(trigger).not.toHaveClass("group")
    expect(trigger.querySelector("svg")).not.toHaveClass("group-hover:text-neutral-400")
  })

  it("gives open options the #F2E8FF (primary-subtle) hover surface", async () => {
    render(<MultiSelect options={OPTIONS} value={[]} onChange={() => {}} aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    const option = await screen.findByRole("checkbox", { name: "Alpha" })
    // #F2E8FF == the primary-subtle token — same option-hover tint as the single Select.
    expect(option).toHaveClass("hover:bg-primary-subtle")
    expect(option).not.toHaveClass("hover:bg-accent")
  })

  it("stages ticks locally and commits them only on Apply", async () => {
    const onChange = vi.fn()
    render(<MultiSelect options={OPTIONS} value={[]} onChange={onChange} aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    await userEvent.click(await screen.findByRole("checkbox", { name: "Alpha" }))
    // Staged only — the committed value is untouched until Apply.
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Apply" }))
    expect(onChange).toHaveBeenCalledWith(["a@x.com"])
  })

  it("discards the staged draft when dismissed without applying", async () => {
    const onChange = vi.fn()
    render(
      <div>
        <p>outside</p>
        <MultiSelect options={OPTIONS} value={[]} onChange={onChange} aria-label="Picker" />
      </div>
    )
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    await userEvent.click(await screen.findByRole("checkbox", { name: "Alpha" }))
    await userEvent.click(screen.getByText("outside"))
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Alpha" })).not.toBeInTheDocument()
    )
    expect(onChange).not.toHaveBeenCalled()
    // Reopening reseeds the draft from the committed value → Alpha is unticked.
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    expect(await screen.findByRole("checkbox", { name: "Alpha" })).toHaveAttribute("aria-checked", "false")
  })

  it("Clear resets the staged draft without committing", async () => {
    const onChange = vi.fn()
    render(<MultiSelect options={OPTIONS} value={[]} onChange={onChange} aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    await userEvent.click(await screen.findByRole("checkbox", { name: "Alpha" }))
    await userEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(screen.getByRole("checkbox", { name: "Alpha" })).toHaveAttribute("aria-checked", "false")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("enables Apply only once the draft differs from the committed value", async () => {
    render(<MultiSelect options={OPTIONS} value={[]} onChange={() => {}} aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled()
    await userEvent.click(await screen.findByRole("checkbox", { name: "Alpha" }))
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled()
  })

  it("shows the committed count on the trigger and clears it via the × button", async () => {
    const onChange = vi.fn()
    render(
      <MultiSelect
        options={OPTIONS}
        value={["a@x.com"]}
        onChange={onChange}
        placeholder="Instructors"
        aria-label="Picker"
      />
    )
    expect(screen.getByRole("button", { name: "Picker" })).toHaveTextContent("Instructors (1)")
    await userEvent.click(screen.getByRole("button", { name: "Clear Picker" }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("does not render removable tag pills below the trigger", () => {
    render(<MultiSelect options={OPTIONS} value={["a@x.com"]} onChange={() => {}} aria-label="Picker" />)
    expect(screen.queryByRole("button", { name: "Remove Alpha" })).not.toBeInTheDocument()
  })

  it("shows the empty text when there are no options", async () => {
    render(<MultiSelect options={[]} value={[]} onChange={() => {}} emptyText="Nothing here" aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    expect(await screen.findByText("Nothing here")).toBeInTheDocument()
  })

  it("does not open when disabled", async () => {
    render(<MultiSelect options={OPTIONS} value={[]} onChange={() => {}} aria-label="Picker" disabled />)
    const trigger = screen.getByRole("button", { name: "Picker" })
    expect(trigger).toBeDisabled()
    await userEvent.click(trigger)
    expect(screen.queryByRole("checkbox", { name: "Alpha" })).not.toBeInTheDocument()
  })

  it("closes on outside click when rendered inside a modal Dialog", async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Add course</DialogTitle>
          <p>elsewhere in the dialog</p>
          <MultiSelect options={OPTIONS} value={[]} onChange={() => {}} aria-label="Picker" />
        </DialogContent>
      </Dialog>
    )
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    expect(await screen.findByRole("checkbox", { name: "Alpha" })).toBeInTheDocument()
    // Click elsewhere inside the dialog (outside the open dropdown).
    await userEvent.click(screen.getByText("elsewhere in the dialog"))
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Alpha" })).not.toBeInTheDocument()
    )
  })
})
