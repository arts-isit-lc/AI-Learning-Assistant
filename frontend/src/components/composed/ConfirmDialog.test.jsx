import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConfirmDialog } from "./ConfirmDialog"

describe("ConfirmDialog", () => {
  it("renders title/description when open and fires onConfirm", async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Delete course?"
        description="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />
    )
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Delete course?")
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
