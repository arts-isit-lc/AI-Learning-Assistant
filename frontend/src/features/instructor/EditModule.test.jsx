import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const editModule = { mutate: vi.fn(), isPending: false }
const deleteModule = { mutate: vi.fn(), isPending: false }
const validate = { mutateAsync: vi.fn().mockResolvedValue({ has_conflicts: false }) }
let filesResult

const MODULE = {
  module_id: "m1",
  module_name: "Vectors",
  concept_id: "con1",
  module_prompt: "Explain vectors",
  key_topics: ["dot product"],
}

vi.mock("@/services/queries", () => ({
  useModules: () => ({ data: [MODULE] }),
  useConcepts: () => ({ data: [{ concept_id: "con1", concept_name: "algebra" }] }),
  useCourseFiles: () => ({ data: [] }),
  useModuleReferences: () => ({ data: [] }),
  useModuleAllFiles: () => filesResult,
  useEditModule: () => editModule,
  useDeleteModule: () => deleteModule,
  useValidatePrompt: () => validate,
}))
vi.mock("./hooks/useFileUpload", () => ({
  useFileUpload: () => ({ fileStates: {}, uploadFiles: vi.fn(), removeFile: vi.fn() }),
}))
vi.mock("./hooks/useProcessingPoller", () => ({
  useProcessingPoller: () => ({ trackedFiles: {}, addTrackedFiles: vi.fn() }),
}))
vi.mock("./hooks/useModuleTopics", () => ({
  useModuleTopics: () => ({ generate: vi.fn(), isGenerating: false }),
}))
const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ courseId: "c1", moduleId: "m1" }),
    useNavigate: () => navigate,
    useLocation: () => ({ state: { module: MODULE } }),
    // The editor renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. Bare render — stub the blocker as never-blocking; the guard's own
    // behaviour is covered in UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})

import { EditModule } from "./EditModule"

beforeEach(() => {
  filesResult = { data: [{ fileName: "notes.pdf", file_id: "f1", fileType: "pdf" }] }
  editModule.mutate.mockClear()
  deleteModule.mutate.mockClear()
  navigate.mockClear()
})

describe("EditModule", () => {
  it("hovers the Save changes button to #2E0666 (primary-dark)", () => {
    render(<EditModule />)
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("hover:bg-primary-dark")
  })

  it("gives the Delete module button no hover state (background unchanged on hover)", () => {
    render(<EditModule />)
    const del = screen.getByRole("button", { name: "Delete module" })
    expect(del).toHaveClass("hover:bg-destructive")
    expect(del).not.toHaveClass("hover:bg-destructive/90")
  })

  it("seeds the form from the module record", () => {
    render(<EditModule />)
    expect(screen.getByLabelText("Module name")).toHaveValue("Vectors")
    expect(screen.getByLabelText("Module prompt")).toHaveValue("Explain vectors")
    expect(screen.getByText("dot product")).toBeInTheDocument()
    expect(screen.getByText("notes.pdf")).toBeInTheDocument()
  })

  it("keeps Save changes disabled until an edit is made", async () => {
    render(<EditModule />)
    // Nothing changed yet — saving is a no-op, so the button is inactive.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Module name"), " II")
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })

  it("saves the collected values", async () => {
    render(<EditModule />)
    // An edit is required before Save is enabled.
    await userEvent.type(screen.getByLabelText("Module name"), " II")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(editModule.mutate).toHaveBeenCalled()
    const [payload] = editModule.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      moduleId: "m1",
      conceptId: "con1",
      moduleName: "Vectors II",
      modulePrompt: "Explain vectors",
      removedFiles: [],
    })
  })

  it("marks an existing file for removal", async () => {
    render(<EditModule />)
    await userEvent.click(screen.getByRole("button", { name: "Remove notes.pdf" }))
    expect(screen.queryByText("notes.pdf")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const [payload] = editModule.mutate.mock.calls[0]
    expect(payload.removedFiles).toContain("notes.pdf")
  })

  it("deletes the module after confirmation", async () => {
    render(<EditModule />)
    await userEvent.click(screen.getByRole("button", { name: "Delete module" }))
    // The editor is itself a modal; the confirm is a second dialog — scope to it.
    expect(await screen.findByText("Delete module?")).toBeInTheDocument()
    const confirm = screen
      .getAllByRole("dialog")
      .find((d) => within(d).queryByText("Delete module?"))
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() => expect(deleteModule.mutate).toHaveBeenCalled())
  })

  it("shows a 400 duplicate-name error inline when saving fails", async () => {
    editModule.isError = true
    editModule.error = { status: 400 }
    render(<EditModule />)
    expect(screen.getByRole("alert")).toHaveTextContent("A module with this name already exists.")
    editModule.isError = false
    editModule.error = null
  })
})
