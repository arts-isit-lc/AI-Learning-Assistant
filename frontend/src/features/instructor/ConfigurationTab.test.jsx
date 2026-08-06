import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { groupConceptTree, reconcileOrder, ConfigurationTab } from "./ConfigurationTab"

let conceptsResult
let modulesResult
const createConcept = { mutate: vi.fn(), isPending: false }
const renameConcept = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isError: false, isPending: false }
const deleteConcept = { mutate: vi.fn(), isPending: false }
const deleteModule = { mutate: vi.fn(), isPending: false }
const reorderConcepts = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isError: false, isPending: false }
const reorderModules = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isError: false, isPending: false }
const navigate = vi.fn()
const setIsInstructorAsStudent = vi.fn()

vi.mock("@/services/queries", () => ({
  useConcepts: () => conceptsResult,
  useModules: () => modulesResult,
  useCreateConcept: () => createConcept,
  useRenameConcept: () => renameConcept,
  useDeleteConcept: () => deleteConcept,
  useDeleteModule: () => deleteModule,
  useReorderConcepts: () => reorderConcepts,
  useReorderModules: () => reorderModules,
  // Lazy per-module fetches used by the expanded ModuleAccordion row.
  useCourseFiles: () => ({ data: [] }),
  useModuleReferences: () => ({ data: [] }),
  useModuleAllFiles: () => ({ data: [] }),
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ courseId: "c1" }),
    useNavigate: () => navigate,
    // ConfigurationTab now renders <UnsavedChangesPrompt> (useBlocker needs a data
    // router). Stub it as never-blocking; the guard is covered in its own test.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ setIsInstructorAsStudent }),
}))

const CONCEPTS = [{ concept_id: "con1", concept_name: "algebra", concept_number: 1 }]
const MODULES = [
  { module_id: "m1", module_name: "vectors", concept_id: "con1", module_number: 2 },
  { module_id: "m2", module_name: "matrices", concept_id: "con1", module_number: 1 },
]

beforeEach(() => {
  conceptsResult = { data: CONCEPTS, isLoading: false, isError: false }
  modulesResult = { data: MODULES, isLoading: false, isError: false }
  Object.values({ createConcept, renameConcept, deleteConcept, deleteModule, reorderConcepts, reorderModules }).forEach(
    (m) => {
      m.mutate.mockClear()
      m.mutateAsync?.mockClear()
    }
  )
  navigate.mockClear()
  setIsInstructorAsStudent.mockClear()
})

describe("groupConceptTree", () => {
  it("groups modules under their concept, sorted by module_number", () => {
    const tree = groupConceptTree(CONCEPTS, MODULES)
    expect(tree).toHaveLength(1)
    expect(tree[0].concept.concept_id).toBe("con1")
    expect(tree[0].modules.map((m) => m.module_id)).toEqual(["m2", "m1"]) // number 1 before 2
  })

  it("falls back to concept_name when concept_id is absent", () => {
    const tree = groupConceptTree(CONCEPTS, [{ module_id: "m3", module_name: "x", concept_name: "algebra" }])
    expect(tree[0].modules.map((m) => m.module_id)).toEqual(["m3"])
  })
})

describe("reconcileOrder (staged reorder resilience)", () => {
  it("returns the server order when nothing is staged", () => {
    expect(reconcileOrder(["a", "b", "c"], null)).toEqual(["a", "b", "c"])
  })

  it("keeps the staged order for ids that still exist", () => {
    expect(reconcileOrder(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"])
  })

  it("drops staged ids that were deleted and appends newly-added server ids last", () => {
    // 'x' was staged then deleted server-side; 'd' is new on the server → appended.
    expect(reconcileOrder(["a", "b", "d"], ["b", "x", "a"])).toEqual(["b", "a", "d"])
  })
})

describe("ConfigurationTab", () => {
  it("renders the numbered concept tree with its roman-numbered modules (sorted by module_number)", () => {
    render(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "1. Algebra" })).toBeInTheDocument()
    // MODULES sort by module_number: matrices (1) -> "i", vectors (2) -> "ii".
    expect(screen.getByRole("button", { name: "i. Matrices" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ii. Vectors" })).toBeInTheDocument()
  })

  it("gives the Add concept / Add module buttons the brand #F2E8FF hover (outline variant)", () => {
    render(<ConfigurationTab />)
    // Both use the shared `outline` Button variant, which carries
    // hover:bg-primary-subtle (#F2E8FF). concepts.length > 0 here, so Add module
    // is enabled and still receives the hover.
    expect(screen.getByRole("button", { name: /add concept/i })).toHaveClass("hover:bg-primary-subtle")
    expect(screen.getByRole("button", { name: /add module/i })).toHaveClass("hover:bg-primary-subtle")
  })

  it("fixes the Add concept / Add module buttons at 30px tall (h-[30px], border-box incl. border)", () => {
    render(<ConfigurationTab />)
    // Explicit height (not padding) drives the size — border-box means 30px is
    // the total box height including the 1px outline border.
    expect(screen.getByRole("button", { name: /add concept/i })).toHaveClass("h-[30px]")
    expect(screen.getByRole("button", { name: /add module/i })).toHaveClass("h-[30px]")
  })

  it("greys the disabled Add module button — #BFBFBF (neutral-400) border + text, no opacity fade", () => {
    conceptsResult = { data: [], isLoading: false, isError: false }
    modulesResult = { data: [], isLoading: false, isError: false }
    render(<ConfigurationTab />)
    const addModule = screen.getByRole("button", { name: /add module/i })
    expect(addModule).toBeDisabled()
    expect(addModule).toHaveClass("disabled:border-neutral-400")
    expect(addModule).toHaveClass("disabled:text-neutral-400")
    // Overrides the base disabled:opacity-50 so #BFBFBF renders true, not faded.
    expect(addModule).toHaveClass("disabled:opacity-100")
    expect(addModule).not.toHaveClass("disabled:opacity-50")
  })

  it("creates a concept from the inline add form", async () => {
    render(<ConfigurationTab />)
    await userEvent.click(screen.getByRole("button", { name: /add concept/i }))
    await userEvent.type(screen.getByRole("textbox", { name: "New concept name" }), "Kinematics")
    await userEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(createConcept.mutate).toHaveBeenCalledWith(
      { conceptName: "Kinematics", nextNumber: 2 },
      expect.any(Object)
    )
  })

  it("deletes a concept (cascade) after confirmation", async () => {
    render(<ConfigurationTab />)
    await userEvent.click(screen.getByRole("button", { name: "Delete concept" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(deleteConcept.mutate).toHaveBeenCalled()
    const [arg] = deleteConcept.mutate.mock.calls[0]
    expect(arg.concept.concept_id).toBe("con1")
    expect(arg.modules).toHaveLength(2)
  })

  it("shows the empty state with no in-panel action button when there are no concepts", () => {
    conceptsResult = { data: [], isLoading: false, isError: false }
    render(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "No concepts yet" })).toBeInTheDocument()
    // Per Figma 1099:6510 the empty state has no action button of its own — the
    // header "Concept" button is the only add-concept affordance, so a single
    // getByRole match (which throws on duplicates) proves the redundant one is gone.
    expect(screen.getByRole("button", { name: /add concept/i })).toBeInTheDocument()
  })

  it("shows the Student view + Save changes footer even when there are no concepts", () => {
    conceptsResult = { data: [], isLoading: false, isError: false }
    render(<ConfigurationTab />)
    expect(screen.getByRole("button", { name: "Student view" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument()
  })

  it("previews the course as a student from the footer (enters preview mode + navigates)", async () => {
    render(<ConfigurationTab />)
    await userEvent.click(screen.getByRole("button", { name: "Student view" }))
    expect(setIsInstructorAsStudent).toHaveBeenCalledWith(true)
    expect(navigate).toHaveBeenCalledWith("/courses/c1")
  })

  it("keeps Save changes and Undo disabled until a reorder or rename is staged", () => {
    render(<ConfigurationTab />)
    // Nothing staged yet → nothing to save or undo (add/delete persist immediately).
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
  })

  // --- Staged concept renames + Undo (matches the admin CourseDetail/InstructorDetail
  // Undo pattern: edits buffer locally, Undo reverts them, Save persists them). ---
  it("stages a concept rename — enabling Undo + Save and updating the heading — without persisting", async () => {
    const user = userEvent.setup()
    render(<ConfigurationTab />)
    await user.click(screen.getByRole("button", { name: "Rename concept" }))
    const input = screen.getByRole("textbox", { name: "Concept name" })
    await user.clear(input)
    await user.type(input, "Geometry")
    await user.click(screen.getByRole("button", { name: "Save concept name" }))
    // Staged only — not written through immediately.
    expect(renameConcept.mutate).not.toHaveBeenCalled()
    expect(renameConcept.mutateAsync).not.toHaveBeenCalled()
    // Heading reflects the staged name; Undo + Save light up.
    expect(screen.getByRole("heading", { name: "1. Geometry" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })

  it("reverts a staged concept rename on Undo (name + button state)", async () => {
    const user = userEvent.setup()
    render(<ConfigurationTab />)
    await user.click(screen.getByRole("button", { name: "Rename concept" }))
    const input = screen.getByRole("textbox", { name: "Concept name" })
    await user.clear(input)
    await user.type(input, "Geometry")
    await user.click(screen.getByRole("button", { name: "Save concept name" }))
    expect(screen.getByRole("heading", { name: "1. Geometry" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Undo" }))
    // Back to the server name; nothing persisted; Undo + Save disabled again.
    expect(screen.getByRole("heading", { name: "1. Algebra" })).toBeInTheDocument()
    expect(renameConcept.mutateAsync).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })

  it("persists a staged concept rename on Save changes (keeping its number)", async () => {
    const user = userEvent.setup()
    render(<ConfigurationTab />)
    await user.click(screen.getByRole("button", { name: "Rename concept" }))
    const input = screen.getByRole("textbox", { name: "Concept name" })
    await user.clear(input)
    await user.type(input, "Geometry")
    await user.click(screen.getByRole("button", { name: "Save concept name" }))
    await user.click(screen.getByRole("button", { name: "Save changes" }))
    expect(renameConcept.mutateAsync).toHaveBeenCalledWith({
      conceptId: "con1",
      conceptName: "Geometry",
      conceptNumber: 1,
    })
  })

  it("surfaces an inline error when saving a concept rename fails", () => {
    renameConcept.isError = true
    render(<ConfigurationTab />)
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i)
    renameConcept.isError = false
  })

  it("announces a labelled loading region while the course structure loads", () => {
    conceptsResult = { data: undefined, isLoading: true, isError: false }
    render(<ConfigurationTab />)
    expect(screen.getByRole("status", { name: /loading course structure/i })).toBeInTheDocument()
  })

  it("keeps the skeleton until BOTH concepts and modules load (no staggered pop-in)", () => {
    // Concepts resolved, modules still in flight — the tree must NOT render yet,
    // or concepts would show with their modules popping in a beat later.
    conceptsResult = { data: CONCEPTS, isLoading: false, isError: false }
    modulesResult = { data: undefined, isLoading: true, isError: false }
    render(<ConfigurationTab />)
    expect(screen.getByRole("status", { name: /loading course structure/i })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "1. Algebra" })).not.toBeInTheDocument()
  })

  it("shows the ErrorState if the modules query fails even when concepts succeeded", () => {
    conceptsResult = { data: CONCEPTS, isLoading: false, isError: false }
    modulesResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 } }
    render(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load the course structure" })).toBeInTheDocument()
  })

  it("shows an accessible ErrorState with retry when concepts fail to load", async () => {
    const refetch = vi.fn()
    conceptsResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load the course structure" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → tree)", async () => {
    const refetch = vi.fn()
    conceptsResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load the course structure" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    conceptsResult = { data: CONCEPTS, isLoading: false, isError: false }
    rerender(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "1. Algebra" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load the course structure" })).not.toBeInTheDocument()
  })

  it("shows an inline error when saving the reorder fails", () => {
    reorderConcepts.isError = true
    render(<ConfigurationTab />)
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't save/i)
    reorderConcepts.isError = false
  })
})
