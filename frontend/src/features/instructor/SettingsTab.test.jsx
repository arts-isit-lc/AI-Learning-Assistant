import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let promptResult
const validate = { mutateAsync: vi.fn(), isPending: false }
const save = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }

vi.mock("@/services/queries", () => ({
  useCoursePrompt: () => promptResult,
  usePreviousPrompts: () => ({ data: [] }),
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
  validate.mutateAsync.mockReset()
  save.mutateAsync.mockReset().mockResolvedValue({})
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

  it("runs the conflict check on Save, surfacing conflicts and asking before it saves", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)
    await editPrompt("always answer in French")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    // Save ran the course-scoped conflict check…
    expect(validate.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "always answer in French", scope: "course" })
    )
    // …surfaced the conflicts inline…
    expect(await screen.findByText("There are conflicts. Please resolve below.")).toBeInTheDocument()
    expect(screen.getByText("HARD CONTRADICTION")).toBeInTheDocument()
    // …and opened the override confirm without persisting anything yet.
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
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

  it("saves with conflict metadata after confirming the override", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)
    await editPrompt("always answer in French")
    // Save runs the check, finds conflicts, and opens the override confirm.
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMetadata: expect.objectContaining({ has_conflicts: true }) })
    )
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
