import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ErrorState } from "./ErrorState"

describe("ErrorState", () => {
  it("renders default copy and no retry button when onRetry is absent", () => {
    render(<ErrorState />)
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument()
    expect(screen.getByText("We couldn't load this. Please try again.")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("renders custom copy and fires onRetry when the retry button is clicked", async () => {
    const onRetry = vi.fn()
    render(
      <ErrorState
        title="Couldn't load the roster"
        description="Network problem — check your connection."
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole("heading", { name: "Couldn't load the roster" })).toBeInTheDocument()
    expect(screen.getByText("Network problem — check your connection.")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
