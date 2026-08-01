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

  it("shows an inline error and stays open when `error` is set", () => {
    render(
      <ConfirmDialog
        open
        title="Delete course?"
        description="This cannot be undone."
        confirmLabel="Delete"
        error="Something went wrong on our end. Please try again."
        onConfirm={vi.fn()}
      />
    )
    expect(
      screen.getByText("Something went wrong on our end. Please try again.")
    ).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
