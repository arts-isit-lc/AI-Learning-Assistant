import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const draft = { moduleId: "m1", isReserving: false, reserveError: null, cleanup: vi.fn(), markSaved: vi.fn() }
const finalize = { mutate: vi.fn(), isPending: false }
const validate = { mutateAsync: vi.fn().mockResolvedValue({ has_conflicts: false }) }
const navigate = vi.fn()
// Per-test processing state (step 1 gating). Empty = nothing in flight.
let trackedFilesResult = {}
// Per-test auto-suggest result (drives the "Suggest"/restore flow).
let generateResult = { topics: [] }
// Per-test sibling modules (step-0 duplicate-name check). Empty = no collisions.
let modulesResult = []
// Per-test upload state. Default: one already-uploaded file so step 1 can advance.
let fileStatesResult = { f1: { fileId: "f1", fileName: "notes.pdf", status: "upload_complete", progress: 100 } }

vi.mock("./hooks/useDraftModule", () => ({ useDraftModule: () => draft }))
vi.mock("./hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    fileStates: fileStatesResult,
    uploadFiles: vi.fn().mockResolvedValue([{ fileId: "f1", fileName: "notes.pdf" }]),
    removeFile: vi.fn(),
  }),
}))
vi.mock("./hooks/useProcessingPoller", () => ({
  useProcessingPoller: () => ({ trackedFiles: trackedFilesResult, addTrackedFiles: vi.fn() }),
}))
vi.mock("./hooks/useModuleTopics", () => ({
  useModuleTopics: () => ({ generate: vi.fn().mockResolvedValue(generateResult), isGenerating: false }),
}))
vi.mock("@/services/queries", () => ({
  useConcepts: () => ({ data: [{ concept_id: "con1", concept_name: "algebra" }] }),
  useModules: () => ({ data: modulesResult }),
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

import { CourseWizard } from "./CourseWizard"

beforeEach(() => {
  finalize.mutate.mockClear()
  draft.cleanup.mockClear()
  draft.markSaved.mockClear()
  navigate.mockClear()
  validate.mutateAsync.mockReset().mockResolvedValue({ has_conflicts: false })
  trackedFilesResult = {}
  generateResult = { topics: [] }
  modulesResult = []
  fileStatesResult = { f1: { fileId: "f1", fileName: "notes.pdf", status: "upload_complete", progress: 100 } }
})

async function advance() {
  const user = userEvent.setup()
  render(<CourseWizard />)
  // Step 0: details
  await user.type(screen.getByLabelText("Module name"), "Vectors")
  await user.click(screen.getByRole("button", { name: "Next" })) // -> References
  await user.click(screen.getByRole("button", { name: "Next" })) // -> Prompt & topics
  // Step 2 gates on >=1 key topic.
  await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}")
  await user.click(screen.getByRole("button", { name: "Next" })) // -> Review
  return user
}

describe("CourseWizard", () => {
  it("hovers the Next primary button to #2E0666 (primary-dark)", () => {
    render(<CourseWizard />)
    expect(screen.getByRole("button", { name: "Next" })).toHaveClass("hover:bg-primary-dark")
  })

  it("hovers the Back button to #F2E8FF (primary-subtle), not the ghost grey", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // step 0 -> references (Back appears)
    const back = screen.getByRole("button", { name: "Back" })
    expect(back).toHaveClass("hover:bg-primary-subtle")
    expect(back).not.toHaveClass("hover:bg-accent")
  })

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

  it("keeps Next disabled on the references step while a file is still ingesting", async () => {
    // f1 finished uploading (mock) but is still processing -> must wait here.
    trackedFilesResult = { f1: { fileId: "f1", status: "processing" } }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // step 0 -> references
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
  })

  it("discards the draft from the footer Cancel button (with confirm)", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    // Footer "Cancel" opens the discard confirm (the only Cancel button until it opens).
    await user.click(screen.getByRole("button", { name: "Cancel" }))
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

  it("keeps Cancel on every step and reveals Back only after the first step", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    // Step 0: Cancel present (the footer discard action), Back hidden.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    // Step 1: Back now visible, Cancel still present.
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("labels a fully-processed file 'Complete' in green", async () => {
    trackedFilesResult = { f1: { fileId: "f1", status: "complete" } }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references (file list)
    const label = screen.getByText("Complete")
    expect(label).toBeInTheDocument()
    expect(label).toHaveClass("text-success")
    // Terminal states are static — no glow.
    expect(label).not.toHaveClass("animate-pulse-glow")
  })

  it("captures a per-file description and sends it to finalize", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    // Expand the file's Description accordion and type into it.
    await user.click(screen.getByRole("button", { name: /Description \(optional\)/i }))
    await user.type(screen.getByLabelText("Description for notes.pdf"), "Core reading")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}") // gate: >=1 topic
    await user.click(screen.getByRole("button", { name: "Next" })) // -> review
    await user.click(screen.getByRole("button", { name: "Publish" }))
    expect(finalize.mutate).toHaveBeenCalled()
    const [payload] = finalize.mutate.mock.calls[0]
    expect(payload.fileDescriptions).toEqual([{ fileName: "notes.pdf", description: "Core reading" }])
  })

  it("does not offer a description on a failed upload", async () => {
    trackedFilesResult = { f1: { fileId: "f1", status: "failed" } }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    expect(screen.queryByRole("button", { name: /Description \(optional\)/i })).not.toBeInTheDocument()
  })

  it("makes the in-progress status label glow while a file is ingesting", async () => {
    trackedFilesResult = { f1: { fileId: "f1", status: "ingesting" } }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    // The whole label glows (replacing the old animated ellipsis) with a trailing "…".
    const label = screen.getByText(/Reading document/)
    expect(label).toBeInTheDocument()
    expect(label).toHaveClass("animate-pulse-glow")
    expect(screen.queryByTestId("animated-ellipsis")).not.toBeInTheDocument()
  })

  it("glows the status and shows no progress bar while a file is uploading", async () => {
    fileStatesResult = { f1: { fileId: "f1", fileName: "notes.pdf", status: "uploading", progress: 40 } }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    const label = screen.getByText(/Uploading/)
    expect(label).toHaveClass("animate-pulse-glow")
    // The per-file upload bar is gone; only the wizard's step progress bar remains.
    expect(screen.getAllByRole("progressbar")).toHaveLength(1)
  })

  it("shows 'Analyzing content…' while enriching and keeps Publish gated", async () => {
    trackedFilesResult = { f1: { fileId: "f1", status: "enriching" } }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    const label = screen.getByText(/Analyzing content/)
    expect(label).toBeInTheDocument()
    expect(label).toHaveClass("animate-pulse-glow")
    // 'enriching' is a blocking status, so the user can't advance until 'complete'.
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
  })

  it("lets you edit a key topic by clicking it", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    // Add a topic with a typo, then click it to fix it in place.
    await user.type(screen.getByLabelText("Add key topic"), "vetcors{Enter}")
    await user.click(screen.getByRole("button", { name: "Edit vetcors" }))
    const input = screen.getByRole("textbox", { name: "Edit key topic" })
    await user.clear(input)
    await user.type(input, "vectors{Enter}")
    expect(screen.getByRole("button", { name: "Edit vectors" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit vetcors" })).not.toBeInTheDocument()
  })

  it("keeps Suggest inactive until a suggested topic is removed, then restores it", async () => {
    trackedFilesResult = { f1: { fileId: "f1", status: "complete" } }
    generateResult = { topics: ["alpha", "beta"] }
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    // Auto-suggest populates topics; Suggest starts inactive (nothing to restore).
    expect(await screen.findByRole("button", { name: "Edit alpha" })).toBeInTheDocument()
    const suggest = screen.getByRole("button", { name: "Suggest" })
    expect(suggest).toBeDisabled()
    // Inactive styling: #808080 (neutral-500) border+text, not the faded-purple default.
    expect(suggest).toHaveClass("disabled:text-neutral-500", "disabled:border-neutral-500")
    // Removing a suggested topic activates Suggest.
    await user.click(screen.getByRole("button", { name: "Remove alpha" }))
    expect(screen.queryByRole("button", { name: "Edit alpha" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Suggest" })).toBeEnabled()
    // Clicking Suggest restores the removed topic and goes inactive again.
    await user.click(screen.getByRole("button", { name: "Suggest" }))
    expect(await screen.findByRole("button", { name: "Edit alpha" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Suggest" })).toBeDisabled()
  })

  it("runs the prompt conflict check on Next when a module prompt was entered", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}")
    await user.type(screen.getByLabelText("Module prompt"), "Always answer in French.")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> review (triggers the check)
    expect(validate.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Always answer in French.", scope: "module", moduleId: "m1" })
    )
  })

  it("skips the prompt conflict check on Next when the module prompt is empty", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    // No module prompt entered (it's optional), but a key topic is required to advance.
    await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> review
    expect(validate.mutateAsync).not.toHaveBeenCalled()
  })

  it("blocks advancing with a loading state while the conflict check runs", async () => {
    let resolveCheck
    validate.mutateAsync.mockReturnValueOnce(new Promise((res) => (resolveCheck = res)))
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}")
    await user.type(screen.getByLabelText("Module prompt"), "Some instructions")
    await user.click(screen.getByRole("button", { name: "Next" }))
    // Blocked on the prompt step; Next is disabled (loading) while checking, and
    // the step's fields are frozen so nothing can change mid-validation.
    expect(screen.getByLabelText("Module prompt")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
    expect(screen.getByLabelText("Module prompt")).toBeDisabled()
    expect(screen.getByLabelText("Add key topic")).toBeDisabled()
    // Resolve with no conflicts → advances off the prompt step.
    resolveCheck({ has_conflicts: false })
    await waitFor(() => expect(screen.queryByLabelText("Module prompt")).not.toBeInTheDocument())
  })

  it("shows the inline conflict report, warns on a second Next, and proceeds on Okay", async () => {
    validate.mutateAsync.mockResolvedValue({
      has_conflicts: true,
      conflicts: [
        {
          type: "HARD_CONTRADICTION",
          prompt_a_source: "system_prompt",
          prompt_b_source: "module_prompt:Vectors",
          explanation: "Conflict on summaries.",
        },
      ],
    })
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}")
    await user.type(screen.getByLabelText("Module prompt"), "Always answer in French.")
    // First Next: the check finds conflicts → stay + inline conflict report.
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(validate.mutateAsync).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText("Module prompt")).toBeInTheDocument()
    expect(screen.getByText("There are conflicts. Please resolve below.")).toBeInTheDocument()
    expect(screen.getByText("HARD CONTRADICTION")).toBeInTheDocument()
    // Second Next (unresolved): opens the confirm warning without re-checking.
    await user.click(screen.getByRole("button", { name: "Next" }))
    expect(validate.mutateAsync).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("Prompt conflicts detected")).toBeInTheDocument()
    // Okay proceeds to the review step.
    await user.click(screen.getByRole("button", { name: "Okay" }))
    await waitFor(() => expect(screen.queryByLabelText("Module prompt")).not.toBeInTheDocument())
  })

  it("gates Next on step 2 until at least one key topic exists", async () => {
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" })) // -> references
    await user.click(screen.getByRole("button", { name: "Next" })) // -> prompt & topics
    // Nothing auto-suggested (no processed files) → no topics yet, Next is gated.
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
    await user.type(screen.getByLabelText("Add key topic"), "vectors{Enter}")
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled()
  })

  it("blocks a duplicate module name within the same concept and clears the error on edit", async () => {
    // An existing module in the same concept (con1, preselected via ?concept).
    modulesResult = [{ module_id: "existing", module_name: "Vectors", concept_id: "con1" }]
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" }))
    // Stays on step 0 with an inline error (references step not shown).
    expect(
      screen.getByText("A module with this name already exists in this concept.")
    ).toBeInTheDocument()
    expect(screen.queryByLabelText("Upload files")).not.toBeInTheDocument()
    // Editing the name clears the error.
    await user.type(screen.getByLabelText("Module name"), "2")
    expect(
      screen.queryByText("A module with this name already exists in this concept.")
    ).not.toBeInTheDocument()
  })

  it("allows a name that only collides with a module in a different concept", async () => {
    // Same name, but the existing module is in con2 while this draft is con1.
    modulesResult = [{ module_id: "existing", module_name: "Vectors", concept_id: "con2" }]
    const user = userEvent.setup()
    render(<CourseWizard />)
    await user.type(screen.getByLabelText("Module name"), "Vectors")
    await user.click(screen.getByRole("button", { name: "Next" }))
    // Advanced to the references step, no inline error.
    expect(screen.getByLabelText("Upload files")).toBeInTheDocument()
    expect(
      screen.queryByText("A module with this name already exists in this concept.")
    ).not.toBeInTheDocument()
  })

  it("shows a 400 duplicate-name error inline when publishing fails", async () => {
    finalize.isError = true
    finalize.error = { status: 400 }
    render(<CourseWizard />)
    expect(screen.getByRole("alert")).toHaveTextContent("A module with this name already exists.")
    finalize.isError = false
    finalize.error = null
  })
})
