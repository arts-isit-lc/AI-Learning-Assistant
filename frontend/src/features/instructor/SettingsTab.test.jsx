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

const CLEAN = { has_conflicts: false, conflicts: [], validation_status: "clean" }
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

describe("SettingsTab — conflict-check-on-save", () => {
  it("validates then saves immediately when there are no conflicts", async () => {
    validate.mutateAsync.mockResolvedValue(CLEAN)
    render(<SettingsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(validate.mutateAsync).toHaveBeenCalledWith({ prompt: "Teach kindly", scope: "course" })
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Teach kindly", conflictMetadata: null })
    )
  })

  it("blocks on conflict, shows it, and saves anyway after override confirm", async () => {
    validate.mutateAsync.mockResolvedValue(CONFLICT)
    render(<SettingsTab />)

    // First save → validates, blocks, shows the conflict (no save yet).
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(screen.getByText("Language instructions clash")).toBeInTheDocument())
    expect(save.mutateAsync).not.toHaveBeenCalled()

    // Second save → override dialog → Save anyway → persists with conflict_metadata.
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }))

    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalled())
    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMetadata: expect.objectContaining({ has_conflicts: true }) })
    )
  })

  it("still saves when validation is unavailable", async () => {
    validate.mutateAsync.mockRejectedValue(new Error("503"))
    render(<SettingsTab />)
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ conflictMetadata: null })
    ))
  })

  it("shows the read-only system prompt", () => {
    render(<SettingsTab />)
    expect(screen.getByText(/Socratic teaching style/i)).toBeInTheDocument()
  })
})
