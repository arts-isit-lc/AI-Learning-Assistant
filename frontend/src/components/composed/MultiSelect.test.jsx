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

  it("selects an option (adds its value) via the dropdown", async () => {
    const onChange = vi.fn()
    render(<MultiSelect options={OPTIONS} value={[]} onChange={onChange} aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    await userEvent.click(await screen.findByRole("button", { name: "Alpha" }))
    expect(onChange).toHaveBeenCalledWith(["a@x.com"])
  })

  it("deselects an already-selected option", async () => {
    const onChange = vi.fn()
    render(<MultiSelect options={OPTIONS} value={["a@x.com"]} onChange={onChange} aria-label="Picker" />)
    // Trigger summarizes the count; the option toggles off when re-clicked.
    expect(screen.getByRole("button", { name: "Picker" })).toHaveTextContent("1 selected")
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    await userEvent.click(await screen.findByRole("button", { name: "Alpha" }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("renders the selection as removable tags", async () => {
    const onChange = vi.fn()
    render(<MultiSelect options={OPTIONS} value={["a@x.com"]} onChange={onChange} aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Remove Alpha" }))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("shows the empty text when there are no options", async () => {
    render(<MultiSelect options={[]} value={[]} onChange={() => {}} emptyText="Nothing here" aria-label="Picker" />)
    await userEvent.click(screen.getByRole("button", { name: "Picker" }))
    expect(await screen.findByText("Nothing here")).toBeInTheDocument()
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
    expect(await screen.findByRole("button", { name: "Alpha" })).toBeInTheDocument()
    // Click elsewhere inside the dialog (outside the open dropdown).
    await userEvent.click(screen.getByText("elsewhere in the dialog"))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument()
    )
  })
})
