import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { groupConceptTree, ConfigurationTab } from "./ConfigurationTab"

let conceptsResult
let modulesResult
const createConcept = { mutate: vi.fn(), isPending: false }
const renameConcept = { mutate: vi.fn(), isPending: false }
const deleteConcept = { mutate: vi.fn(), isPending: false }
const deleteModule = { mutate: vi.fn(), isPending: false }
const reorderConcepts = { mutate: vi.fn(), isPending: false }
const reorderModules = { mutate: vi.fn(), isPending: false }
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
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useParams: () => ({ courseId: "c1" }), useNavigate: () => navigate }
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
    (m) => m.mutate.mockClear()
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

describe("ConfigurationTab", () => {
  it("renders the numbered concept tree with its roman-numbered modules (sorted by module_number)", () => {
    render(<ConfigurationTab />)
    expect(screen.getByRole("heading", { name: "1. Algebra" })).toBeInTheDocument()
    // MODULES sort by module_number: matrices (1) -> "i", vectors (2) -> "ii".
    expect(screen.getByRole("button", { name: "i. Matrices" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "ii. Vectors" })).toBeInTheDocument()
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

  it("keeps Save changes disabled — configuration edits persist immediately", () => {
    render(<ConfigurationTab />)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })
})
