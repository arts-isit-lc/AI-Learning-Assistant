import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { UnsavedChangesProvider, useUnsavedChanges } from "./UnsavedChangesContext"

function Harness({ action }) {
  const { setDirty, runGuarded } = useUnsavedChanges()
  return (
    <>
      <button type="button" onClick={() => setDirty(true)}>
        make dirty
      </button>
      <button type="button" onClick={() => runGuarded(action)}>
        go
      </button>
    </>
  )
}

describe("UnsavedChangesProvider", () => {
  it("runs the guarded action immediately when there are no unsaved changes", async () => {
    const action = vi.fn()
    render(
      <UnsavedChangesProvider>
        <Harness action={action} />
      </UnsavedChangesProvider>
    )
    await userEvent.click(screen.getByRole("button", { name: "go" }))
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("intercepts with a confirm when dirty and proceeds only on confirm", async () => {
    const action = vi.fn()
    render(
      <UnsavedChangesProvider>
        <Harness action={action} />
      </UnsavedChangesProvider>
    )
    await userEvent.click(screen.getByRole("button", { name: "make dirty" }))
    await userEvent.click(screen.getByRole("button", { name: "go" }))
    // Deferred behind the confirm dialog.
    expect(action).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Unsaved changes")).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Leave without saving" }))
    expect(action).toHaveBeenCalledTimes(1)
  })

  it("does not run the action if the leave confirm is cancelled", async () => {
    const action = vi.fn()
    render(
      <UnsavedChangesProvider>
        <Harness action={action} />
      </UnsavedChangesProvider>
    )
    await userEvent.click(screen.getByRole("button", { name: "make dirty" }))
    await userEvent.click(screen.getByRole("button", { name: "go" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    expect(action).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
