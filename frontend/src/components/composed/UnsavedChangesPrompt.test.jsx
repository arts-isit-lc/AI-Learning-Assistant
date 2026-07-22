import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, Link, RouterProvider } from "react-router-dom"
import { UnsavedChangesPrompt } from "./UnsavedChangesPrompt"

// The guard relies on React Router's useBlocker, which only works under a data
// router — so the harness drives it through a real createMemoryRouter with a
// second route to navigate to.
function Editor({ when, onProceed }) {
  return (
    <div>
      <UnsavedChangesPrompt when={when} onProceed={onProceed} />
      <p>editor page</p>
      <Link to="/next">go next</Link>
    </div>
  )
}

function renderWithRouter({ when = false, onProceed } = {}) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <Editor when={when} onProceed={onProceed} /> },
      { path: "/next", element: <p>next page</p> },
    ],
    { initialEntries: ["/"] }
  )
  render(<RouterProvider router={router} />)
}

describe("UnsavedChangesPrompt", () => {
  it("lets navigation through untouched when there are no unsaved changes", async () => {
    renderWithRouter({ when: false })
    await userEvent.click(screen.getByRole("link", { name: "go next" }))
    expect(await screen.findByText("next page")).toBeInTheDocument()
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
  })

  it("blocks in-app navigation when dirty and only proceeds after confirming", async () => {
    renderWithRouter({ when: true })
    await userEvent.click(screen.getByRole("link", { name: "go next" }))

    // Blocked: the confirm shows and we're still on the editor.
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument()
    expect(screen.getByText("editor page")).toBeInTheDocument()
    expect(screen.queryByText("next page")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Leave without saving" }))
    expect(await screen.findByText("next page")).toBeInTheDocument()
  })

  it("stays on the page when the user cancels the leave prompt", async () => {
    renderWithRouter({ when: true })
    await userEvent.click(screen.getByRole("link", { name: "go next" }))
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument())
    expect(screen.getByText("editor page")).toBeInTheDocument()
    expect(screen.queryByText("next page")).not.toBeInTheDocument()
  })

  it("runs the onProceed cleanup hook before leaving", async () => {
    const onProceed = vi.fn()
    renderWithRouter({ when: true, onProceed })
    await userEvent.click(screen.getByRole("link", { name: "go next" }))
    await userEvent.click(await screen.findByRole("button", { name: "Leave without saving" }))

    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("next page")).toBeInTheDocument()
  })
})
