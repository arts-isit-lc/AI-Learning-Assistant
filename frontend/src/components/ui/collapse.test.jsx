import { describe, it, expect } from "vitest"
import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Collapse } from "./collapse"

describe("Collapse", () => {
  it("keeps content reachable by assistive tech when open", () => {
    render(
      <Collapse open>
        <a href="/x">Deep link</a>
      </Collapse>
    )
    expect(screen.getByRole("link", { name: "Deep link" })).toBeInTheDocument()
  })

  it("hides content from assistive tech and the tab order when closed", () => {
    render(
      <Collapse open={false}>
        <a href="/x">Deep link</a>
      </Collapse>
    )
    // Content stays mounted (for the close animation) but is aria-hidden, so
    // role queries — which skip inaccessible nodes — don't find it.
    expect(screen.queryByRole("link", { name: "Deep link" })).not.toBeInTheDocument()
  })

  it("reveals/hides content as `open` toggles", async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen((v) => !v)}>toggle</button>
          <Collapse open={open}>
            <a href="/x">Deep link</a>
          </Collapse>
        </>
      )
    }
    render(<Harness />)

    expect(screen.queryByRole("link", { name: "Deep link" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(screen.getByRole("link", { name: "Deep link" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "toggle" }))
    expect(screen.queryByRole("link", { name: "Deep link" })).not.toBeInTheDocument()
  })
})
