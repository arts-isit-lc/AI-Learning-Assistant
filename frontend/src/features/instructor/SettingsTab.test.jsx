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
  return { ...actual, useParams: () => ({ courseId: "c1" }) }
})
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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

  it("keeps Save disabled until there are unsaved changes", async () => {
    render(<SettingsTab />)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    await editPrompt("Teach with care")
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
  })

  it("checks for conflicts and lists them inline (no save yet)", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)
    await editPrompt("always answer in French")
    await userEvent.click(screen.getByRole("button", { name: "Check for conflicts" }))

    await waitFor(() =>
      expect(screen.getByText("There are conflicts. Please resolve below.")).toBeInTheDocument()
    )
    // Severity pill + "Conflicts with:" summary, expandable to the explanation.
    expect(screen.getByText("HARD CONTRADICTION")).toBeInTheDocument()
    const row = screen.getByRole("button", { name: /Conflicts with: system level prompt/i })
    await userEvent.click(row)
    expect(screen.getByText("Language instructions clash")).toBeInTheDocument()
    expect(save.mutateAsync).not.toHaveBeenCalled()
  })

  it("saves directly (no conflict metadata) when the prompt was not flagged", async () => {
    render(<SettingsTab />)
    await editPrompt("Teach kindly and clearly")
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Teach kindly and clearly", conflictMetadata: null })
    )
  })

  it("requires an override confirm to save once conflicts are flagged", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)
    await editPrompt("always answer in French")
    await userEvent.click(screen.getByRole("button", { name: "Check for conflicts" }))
    await waitFor(() => expect(screen.getByText(/There are conflicts/i)).toBeInTheDocument())

    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMetadata: expect.objectContaining({ has_conflicts: true }) })
    )
  })

  it("still lets you save after a failed conflict check (degradation)", async () => {
    validate.mutateAsync.mockRejectedValue(new Error("503"))
    render(<SettingsTab />)
    await editPrompt("Teach kindly and clearly")
    await userEvent.click(screen.getByRole("button", { name: "Check for conflicts" }))
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    await waitFor(() =>
      expect(save.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ conflictMetadata: null }))
    )
  })
})
