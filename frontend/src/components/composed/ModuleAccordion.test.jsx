import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModuleAccordion, parseKeyTopics } from "./ModuleAccordion"

const concept = { concept_id: "con1", concept_name: "algebra", concept_number: 1 }
const modules = [
  { module_id: "m1", module_name: "vectors", module_prompt: "Explain vectors", key_topics: ["dot product"] },
]

function renderAccordion(overrides = {}) {
  const handlers = {
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onAddModule: vi.fn(),
    onReorderModules: vi.fn(),
    onEditModule: vi.fn(),
    onDeleteModule: vi.fn(),
    ...overrides,
  }
  render(<ModuleAccordion concept={concept} modules={modules} {...handlers} />)
  return handlers
}

describe("parseKeyTopics", () => {
  it("passes through arrays, parses JSON strings, and tolerates junk", () => {
    expect(parseKeyTopics(["a", "b"])).toEqual(["a", "b"])
    expect(parseKeyTopics('["x","y"]')).toEqual(["x", "y"])
    expect(parseKeyTopics("not json")).toEqual([])
    expect(parseKeyTopics(null)).toEqual([])
  })
})

describe("ModuleAccordion", () => {
  it("renders the numbered concept name (title-cased) and its roman-numbered module rows", () => {
    renderAccordion()
    expect(screen.getByRole("heading", { name: "1. Algebra" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "i. Vectors" })).toBeInTheDocument()
  })

  it("expands a module to a read-only summary with Edit/Delete", async () => {
    const { onEditModule } = renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: "i. Vectors" }))
    expect(screen.getByText("Explain vectors")).toBeInTheDocument()
    expect(screen.getByText("dot product")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(onEditModule).toHaveBeenCalledWith(modules[0])
  })

  it("renames the concept via the inline editor", async () => {
    const { onRename } = renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: "Rename concept" }))
    const input = screen.getByRole("textbox", { name: "Concept name" })
    await userEvent.clear(input)
    await userEvent.type(input, "Linear Algebra")
    await userEvent.click(screen.getByRole("button", { name: "Save concept name" }))
    expect(onRename).toHaveBeenCalledWith("Linear Algebra")
  })

  it("fires add-module and delete-concept callbacks", async () => {
    const { onAddModule, onDelete } = renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: /add module/i }))
    expect(onAddModule).toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Delete concept" }))
    expect(onDelete).toHaveBeenCalled()
  })
})
