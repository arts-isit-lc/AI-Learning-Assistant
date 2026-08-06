import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let promptResult
let previousPromptsResult
const validate = { mutateAsync: vi.fn(), isPending: false }
const save = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }

vi.mock("@/services/queries", () => ({
  useCoursePrompt: () => promptResult,
  usePreviousPrompts: () => previousPromptsResult,
  useValidatePrompt: () => validate,
  useSavePrompt: () => save,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useParams: () => ({ courseId: "c1" }),
    // SettingsTab renders <UnsavedChangesPrompt>, whose useBlocker needs a data
    // router. Bare render — stub the blocker as never-blocking; the guard's own
    // behaviour is covered in UnsavedChangesPrompt.test.jsx.
    useBlocker: () => ({ state: "unblocked", proceed: vi.fn(), reset: vi.fn() }),
  }
})

import { SettingsTab } from "./SettingsTab"

const CONFLICT = {
  has_conflicts: true,
  validation_status: "conflicts_found",
  summary: "1 potential conflict found",
  conflicts: [
    {
      type: "HARD_CONTRADICTION",
      severity: "high",
      prompt_a_source: "course_prompt",
      prompt_a_text: "always answer in French",
      prompt_b_source: "system_prompt",
      prompt_b_text: "answer in English",
      explanation: "Language instructions clash",
    },
  ],
}

beforeEach(() => {
  promptResult = {
    data: { system_prompt: "Teach kindly", llm_model_id: "meta.llama3-70b-instruct-v1:0", conflict_metadata: null },
    isLoading: false,
  }
  previousPromptsResult = { data: [], isLoading: false }
  validate.mutateAsync.mockReset()
  validate.isPending = false
  save.mutateAsync.mockReset().mockResolvedValue({})
  save.isPending = false
})

/** Type into the course prompt textarea (also marks the form dirty). */
async function editPrompt(text) {
  const box = screen.getByRole("textbox", { name: "Your prompt" })
  await userEvent.clear(box)
  await userEvent.type(box, text)
}

describe("SettingsTab", () => {
  it("shows the read-only system prompt", () => {
    render(<SettingsTab />)
    expect(screen.getByText(/Socratic teaching style/i)).toBeInTheDocument()
  })

  it("renders the 'View previous prompts' accordion without a divider border", () => {
    render(<SettingsTab />)
    const trigger = screen.getByRole("button", { name: "View previous prompts" })
    // The AccordionItem (border owner) is the nearest div wrapping the trigger.
    const item = trigger.closest("div")
    expect(item).toHaveClass("border-b-0")
    expect(item).not.toHaveClass("border-b")
  })

  it("opens the previous-prompts content without the default pb-4 bottom padding", async () => {
    render(<SettingsTab />)
    await userEvent.click(screen.getByRole("button", { name: "View previous prompts" }))
    // AccordionContent's inner wrapper owns the padding; the empty-state text
    // sits directly inside it. The pb-0 override must beat the default pb-4.
    const wrapper = (await screen.findByText("No previous versions yet.")).parentElement
    expect(wrapper).toHaveClass("pb-0")
    expect(wrapper).not.toHaveClass("pb-4")
  })

  it("shows a loading skeleton in the previous-prompts disclosure while they load", async () => {
    previousPromptsResult = { data: [], isLoading: true }
    render(<SettingsTab />)
    await userEvent.click(screen.getByRole("button", { name: "View previous prompts" }))
    expect(screen.getByRole("status", { name: /loading previous prompts/i })).toBeInTheDocument()
    expect(screen.queryByText("No previous versions yet.")).not.toBeInTheDocument()
  })

  it("no longer renders a separate 'Check for conflicts' button", () => {
    render(<SettingsTab />)
    expect(screen.queryByRole("button", { name: "Check for conflicts" })).not.toBeInTheDocument()
  })

  it("keeps Save disabled until there are unsaved changes", async () => {
    render(<SettingsTab />)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    await editPrompt("Teach with care")
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })

  it("styles Save changes: 28px tall, 4px radius + lavender hover; solid #808080 disabled, #6829C2 when dirty", async () => {
    render(<SettingsTab />)
    const saveBtn = screen.getByRole("button", { name: "Save changes" })
    // 28px tall (h-7), rounded (4px), lavender (#F2E8FF) hover, bordered; not a solid CTA.
    expect(saveBtn).toHaveClass("h-7", "rounded", "hover:bg-primary-subtle", "border")
    expect(saveBtn).not.toHaveClass("bg-primary")
    // Disabled: solid #808080 text (neutral-300 at full opacity) + transparent border.
    expect(saveBtn).toHaveClass("text-neutral-300", "disabled:opacity-100", "border-transparent")
    // Once dirty: #6829C2 text + border.
    await editPrompt("Teach with care")
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("text-primary", "border-primary")
  })

  it("disables the prompt and model fields while the conflict check is running", () => {
    validate.isPending = true
    render(<SettingsTab />)
    expect(screen.getByRole("textbox", { name: "Your prompt" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Language model" })).toBeDisabled()
  })

  it("keeps the prompt and model fields disabled while the save is in flight", () => {
    save.isPending = true
    render(<SettingsTab />)
    expect(screen.getByRole("textbox", { name: "Your prompt" })).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Language model" })).toBeDisabled()
  })

  it("surfaces conflicts inline on Save for review, without opening the override dialog yet", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)
    await editPrompt("always answer in French")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    // Save ran the course-scoped check and rendered the conflicts inline…
    expect(validate.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "always answer in French", scope: "course" })
    )
    expect(await screen.findByText("There are conflicts. Please resolve below.")).toBeInTheDocument()
    expect(screen.getByText("HARD CONTRADICTION")).toBeInTheDocument()
    // …but did NOT open the override dialog or save — the user reviews first.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(save.mutateAsync).not.toHaveBeenCalled()
  })

  it("saves directly (no conflict metadata) when the check finds no conflicts", async () => {
    validate.mutateAsync.mockResolvedValue({ has_conflicts: false })
    render(<SettingsTab />)
    await editPrompt("Teach kindly and clearly")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Teach kindly and clearly", conflictMetadata: null })
    )
  })

  it("opens the override confirm only on a second Save, then saves with conflict metadata", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)
    await editPrompt("always answer in French")
    // First Save surfaces the conflicts inline — still no dialog, nothing saved.
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(screen.getByText(/There are conflicts/i)).toBeInTheDocument())
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(save.mutateAsync).not.toHaveBeenCalled()
    // Second Save (still unresolved) opens the "save anyway?" confirm.
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMetadata: expect.objectContaining({ has_conflicts: true }) })
    )
    // The check ran once — the second Save reused the surfaced report.
    expect(validate.mutateAsync).toHaveBeenCalledTimes(1)
  })

  it("still saves (no metadata) when the conflict check on Save fails (degradation)", async () => {
    validate.mutateAsync.mockRejectedValue(new Error("503"))
    render(<SettingsTab />)
    await editPrompt("Teach kindly and clearly")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    await waitFor(() =>
      expect(save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ conflictMetadata: null }))
    )
  })

  it("shows a labelled skeleton (not plain 'Loading' text or the real form) while the prompt loads", () => {
    promptResult = { data: undefined, isLoading: true }
    render(<SettingsTab />)
    expect(screen.getByRole("status", { name: /loading settings/i })).toBeInTheDocument()
    // The real form controls aren't mounted while loading, and there's no
    // stray "Loading settings…" text line.
    expect(screen.queryByRole("textbox", { name: "Your prompt" })).not.toBeInTheDocument()
    expect(screen.queryByText("Loading settings…")).not.toBeInTheDocument()
  })

  it("shows an accessible ErrorState with retry when the prompt fails to load", async () => {
    const refetch = vi.fn()
    promptResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    render(<SettingsTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load settings" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(refetch).toHaveBeenCalledOnce()
  })

  it("recovers after a successful retry (error → settings)", async () => {
    const refetch = vi.fn()
    promptResult = { data: undefined, isLoading: false, isError: true, error: { status: 500 }, refetch }
    const { rerender } = render(<SettingsTab />)
    expect(screen.getByRole("heading", { name: "Couldn't load settings" })).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    promptResult = {
      data: { system_prompt: "Teach kindly", llm_model_id: "meta.llama3-70b-instruct-v1:0", conflict_metadata: null },
      isLoading: false,
      isError: false,
    }
    rerender(<SettingsTab />)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Couldn't load settings" })).not.toBeInTheDocument()
  })

  it("shows an inline error when saving fails, keeping the prompt text", async () => {
    save.isError = true
    save.error = { status: 500 }
    render(<SettingsTab />)
    await editPrompt("Teach with care")
    expect(screen.getByRole("alert")).toHaveTextContent(/on our end/i)
    expect(screen.getByRole("textbox", { name: "Your prompt" })).toHaveValue("Teach with care")
    save.isError = false
    save.error = null
  })
})
