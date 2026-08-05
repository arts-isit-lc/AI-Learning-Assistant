import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ModuleAccordion, parseKeyTopics } from "./ModuleAccordion"

// The expanded row lazily fetches its Reference + Uploaded files. Stub the hooks
// with deterministic data (no network) so the summary renders predictably.
vi.mock("@/services/queries", () => ({
  useCourseFiles: () => ({ data: [{ file_id: "file-1", filename: "syllabus.pdf" }] }),
  useModuleReferences: () => ({ data: ["file-1"] }),
  useModuleAllFiles: () => ({ data: [{ file_id: "u1", fileName: "notes.pdf" }] }),
}))

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

  it("gives the Delete module summary action no hover state (no underline on hover)", async () => {
    renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: "i. Vectors" }))
    const del = screen.getByRole("button", { name: "Delete module" })
    expect(del).toHaveClass("hover:no-underline")
    expect(del).not.toHaveClass("hover:underline")
  })

  it("greys the module disclosure chevron while its trigger is hovered (group-hover:text-neutral-400)", () => {
    renderAccordion()
    const trigger = screen.getByRole("button", { name: "i. Vectors" })
    expect(trigger).toHaveClass("group")
    expect(trigger.querySelector("svg")).toHaveClass("group-hover:text-neutral-400")
  })

  it("gives the expanded module body the same bg-muted surface as the heading/box", async () => {
    renderAccordion()
    const trigger = screen.getByRole("button", { name: "i. Vectors" })
    // Heading/box surface.
    expect(trigger.closest("[class*='group/module']")).toHaveClass("bg-muted")
    // Expanded body uses the same surface (not the old white bg-background).
    await userEvent.click(trigger)
    const body = screen.getByText("Module name").closest(".rounded-b")
    expect(body).toHaveClass("bg-muted")
    expect(body).not.toHaveClass("bg-background")
  })

  it("renders the summary Edit action as an outline button (purple border), per the mockup", async () => {
    renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: "i. Vectors" }))
    const edit = screen.getByRole("button", { name: "Edit" })
    // Outline variant (border-primary) — not the old borderless text link.
    expect(edit).toHaveClass("border-primary")
    expect(edit).toHaveClass("text-primary")
  })

  it("expands a module to the full read-only summary (all six fields) with Edit/Delete", async () => {
    const { onEditModule, onDeleteModule } = renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: "i. Vectors" }))

    // Six labeled fields per the Figma summary (859:7479).
    expect(screen.getByText("Module name")).toBeInTheDocument()
    expect(screen.getByText("Vectors")).toBeInTheDocument()
    expect(screen.getByText("Concept")).toBeInTheDocument()
    expect(screen.getByText("Algebra")).toBeInTheDocument()
    expect(screen.getByText("Reference")).toBeInTheDocument()
    expect(screen.getByText("syllabus.pdf")).toBeInTheDocument() // reference id resolved to a name
    expect(screen.getByText("Uploaded files")).toBeInTheDocument()
    expect(screen.getByText("notes.pdf")).toBeInTheDocument()
    expect(screen.getByText("Module prompt")).toBeInTheDocument()
    expect(screen.getByText("Explain vectors")).toBeInTheDocument()
    expect(screen.getByText("Key topics")).toBeInTheDocument()
    expect(screen.getByText("dot product")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(onEditModule).toHaveBeenCalledWith(modules[0])
    await userEvent.click(screen.getByRole("button", { name: "Delete module" }))
    expect(onDeleteModule).toHaveBeenCalledWith(modules[0])
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

  // The per-concept "Add module" button was removed in commit 227447b (module
  // creation now lives in the Configuration header), so the concept box only
  // fires delete-concept.
  it("fires the delete-concept callback", async () => {
    const { onDelete } = renderAccordion()
    await userEvent.click(screen.getByRole("button", { name: "Delete concept" }))
    expect(onDelete).toHaveBeenCalled()
  })

  it("darkens the concept pencil + trashcan icons to #2E0666 (primary-dark) on hover", () => {
    renderAccordion()
    const rename = screen.getByRole("button", { name: "Rename concept" })
    const del = screen.getByRole("button", { name: "Delete concept" })
    expect(rename).toHaveClass("hover:text-primary-dark")
    expect(del).toHaveClass("hover:text-primary-dark")
    // Not the old grey→foreground (pencil) / grey→destructive (trashcan) hovers.
    expect(rename).not.toHaveClass("hover:text-foreground")
    expect(del).not.toHaveClass("hover:text-destructive")
  })

  it("sizes modules to the same 600px as concepts but right-aligns them", () => {
    renderAccordion()
    // Concept box: capped at 600px, left (default alignment).
    const conceptBox = screen.getByRole("heading", { name: "1. Algebra" }).closest("div")
    expect(conceptBox).toHaveClass("max-w-[600px]")
    // Module row: same 600px cap, and its list container right-aligns the rows.
    const moduleRow = screen.getByRole("button", { name: "i. Vectors" }).closest("[class*='group/module']")
    expect(moduleRow).toHaveClass("w-full", "max-w-[600px]")
    expect(moduleRow.parentElement).toHaveClass("items-end")
  })

  it("shows the module reorder handle by default (not hidden until hover)", () => {
    renderAccordion()
    expect(screen.getByRole("button", { name: "Reorder vectors" })).not.toHaveClass("opacity-0")
  })

  it("darkens both drag handles (concept + module) to #2E0666 (primary-dark) on hover", () => {
    renderAccordion()
    const conceptHandle = screen.getByRole("button", { name: "Reorder algebra" })
    const moduleHandle = screen.getByRole("button", { name: "Reorder vectors" })
    expect(conceptHandle).toHaveClass("hover:text-primary-dark")
    expect(moduleHandle).toHaveClass("hover:text-primary-dark")
    expect(conceptHandle).not.toHaveClass("hover:text-foreground")
    expect(moduleHandle).not.toHaveClass("hover:text-foreground")
  })
})
