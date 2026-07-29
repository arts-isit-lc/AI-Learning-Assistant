import { describe, it, expect, vi } from "vitest"
import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { EditableTagList } from "./EditableTagList"

// Controlled harness so edits round-trip through onChange like a real parent.
function Harness({ initial = ["algebra", "vectors"], onChange }) {
  const [values, setValues] = useState(initial)
  return (
    <EditableTagList
      values={values}
      onChange={(next) => {
        setValues(next)
        onChange?.(next)
      }}
      ariaLabelPrefix="key topic"
    />
  )
}

describe("EditableTagList", () => {
  it("renders nothing when there are no values", () => {
    const { container } = render(<EditableTagList values={[]} onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("edits a value in place on click + Enter (order preserved)", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit algebra" }))
    const input = screen.getByRole("textbox", { name: "Edit key topic" })
    expect(input).toHaveValue("algebra")
    await user.clear(input)
    await user.type(input, "linear algebra{Enter}")
    expect(screen.getByRole("button", { name: "Edit linear algebra" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit algebra" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit vectors" })).toBeInTheDocument()
  })

  it("cancels an edit on Escape, keeping the original", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole("button", { name: "Edit algebra" }))
    const input = screen.getByRole("textbox", { name: "Edit key topic" })
    await user.clear(input)
    await user.type(input, "changed{Escape}")
    expect(screen.getByRole("button", { name: "Edit algebra" })).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it("removes the tag when edited to empty", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit algebra" }))
    const input = screen.getByRole("textbox", { name: "Edit key topic" })
    await user.clear(input)
    await user.type(input, "{Enter}")
    expect(screen.queryByRole("button", { name: "Edit algebra" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit vectors" })).toBeInTheDocument()
  })

  it("drops a case-insensitive duplicate instead of adding a second", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Edit algebra" }))
    const input = screen.getByRole("textbox", { name: "Edit key topic" })
    await user.clear(input)
    await user.type(input, "VECTORS{Enter}")
    expect(screen.queryByRole("button", { name: "Edit algebra" })).not.toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^Edit vectors$/i })).toHaveLength(1)
  })

  it("removes a tag via its × button", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("button", { name: "Remove algebra" }))
    expect(screen.queryByRole("button", { name: "Edit algebra" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit vectors" })).toBeInTheDocument()
  })
})
