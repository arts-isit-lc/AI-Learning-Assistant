import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const draft = { moduleId: "m1", isReserving: false, reserveError: null, cleanup: vi.fn(), markSaved: vi.fn() }
const finalize = { mutate: vi.fn(), isPending: false }
const validate = { mutateAsync: vi.fn().mockResolvedValue({ has_conflicts: false }) }
const navigate = vi.fn()

vi.mock("./hooks/useDraftModule", () => ({ useDraftModule: () => draft }))
vi.mock("./hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    // one already-uploaded file so step 1 can advance / Save is allowed
    fileStates: { f1: { fileId: "f1", fileName: "notes.pdf", status: "upload_complete", progress: 100 } },
    uploadFiles: vi.fn().mockResolvedValue([{ fileId: "f1", fileName: "notes.pdf" }]),
    removeFile: vi.fn(),
  }),
}))
vi.mock("./hooks/useProcessingPoller", () => ({
  useProcessingPoller: () => ({ trackedFiles: {}, addTrackedFiles: vi.fn() }),
}))
vi.mock("./hooks/useModuleTopics", () => ({
  useModuleTopics: () => ({ generate: vi.fn().mockResolvedValue({ topics: [] }), isGenerating: false }),
}))
vi.mock("@/services/queries", () => ({
  useConcepts: () => ({ data: [{ concept_id: "con1", concept_name: "algebra" }] }),
  useModules: () => ({ data: [] }),
  useCourseFiles: () => ({ data: [] }),
  useFinalizeModule: () => finalize,
  useValidatePrompt: () => validate,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ courseId: "c1" }),
    useNavigate: () => navigate,
    useSearchParams: () => [new URLSearchParams("concept=con1"), vi.fn()],
    // The wizard renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. Bare render — stub the blocker as never-blocking; the guard's own
    // behaviour is covered in UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { CourseWizard } from "./CourseWizard"

beforeEach(() => {
  finalize.mutate.mockClear()
  draft.cleanup.mockClear()
  draft.markSaved.mockClear()
  navigate.mockClear()
})

async function advance() {
  const user = userEvent.setup()
  render(<CourseWizard />)
  // Step 0: details
  await user.type(screen.getByLabelText("Module name"), "Vectors")
  await user.click(screen.getByRole("button", { name: "Next" })) // -> References
  await user.click(screen.getByRole("button", { name: "Next" })) // -> Prompt & topics
  await user.click(screen.getByRole("button", { name: "Next" })) // -> Review
  return user
}

describe("CourseWizard", () => {
  it("walks the 4 steps and finalizes with the collected values", async () => {
    const user = await advance()
    await user.click(screen.getByRole("button", { name: "Publish" }))
    expect(finalize.mutate).toHaveBeenCalled()
    const [payload] = finalize.mutate.mock.calls[0]
    expect(payload).toMatchObject({
      moduleId: "m1",
      conceptId: "con1",
      moduleName: "Vectors",
      moduleNumber: 1,
    })
  })

  it("blocks Next on step 0 until a name is entered", async () => {
    render(<CourseWizard />)
    // concept is preselected via ?concept, but the name is still empty
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Module name"), "Vectors")
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled()
  })

  it("discards the draft from the footer Discard button (with confirm)", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    // Footer "Discard" opens the confirm modal (the only Discard button so far).
    await user.click(screen.getByRole("button", { name: "Discard" }))
    expect(await screen.findByText("Discard this module?")).toBeInTheDocument()
    // Now two dialogs exist (wizard + confirm); click the confirm's Discard.
    const confirm = screen
      .getAllByRole("dialog")
      .find((d) => within(d).queryByText("Discard this module?"))
    await user.click(within(confirm).getByRole("button", { name: "Discard" }))
    await waitFor(() => expect(draft.cleanup).toHaveBeenCalled())
    // Discard cleans up then navigates via an effect (once `leaving` flips), so
    // wait for the navigation rather than asserting it synchronously.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/instructor/courses/c1/configuration")
    )
  })
})
