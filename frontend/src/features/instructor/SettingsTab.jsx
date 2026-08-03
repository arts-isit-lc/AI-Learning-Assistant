import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { useCoursePrompt, usePreviousPrompts, useValidatePrompt, useSavePrompt } from "@/services/queries"
import { LLM_MODELS, DEFAULT_LLM_MODEL_ID } from "@/constants/llmModels"
import { SYSTEM_LEVEL_PROMPT } from "@/constants/systemPrompt"
import { cn } from "@/lib/utils"
import { LanguageModelDropdown } from "@/components/composed/LanguageModelDropdown"
import { PromptHistory } from "@/components/composed/PromptHistory"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { ConflictList } from "@/components/composed/ConflictList"
import { ConflictWarning } from "@/components/composed/ConflictWarning"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { ErrorState } from "@/components/composed/ErrorState"
import { toUserMessage } from "@/services/apiError"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"

const PROMPT_CHAR_LIMIT = 1000
const MODELS = Object.values(LLM_MODELS)

/**
 * Settings tab — Figma 376:2480 / 771:5650. Flat sections (not cards): Language
 * model, the read-only System prompt, then the editable course ("Your") prompt,
 * a **View previous prompts** disclosure, and a footer **Save changes**.
 *
 * Conflict flow: **Save changes** runs the prompt conflict check first. No
 * conflicts → it saves. Conflicts → it renders them inline (red alert + red
 * textarea + severity rows) and asks to confirm before saving anyway (which
 * stores conflict_metadata, keeping the Settings tab dot lit until the prompt is
 * edited and re-saved conflict-free). A failed check doesn't block the save —
 * validation is best-effort (degradation path).
 */
export function SettingsTab() {
  const { courseId } = useParams()
  const { data: promptData, isLoading, isError, error, refetch } = useCoursePrompt(courseId)
  const { data: previousPrompts = [] } = usePreviousPrompts(courseId)
  const validate = useValidatePrompt(courseId)
  const save = useSavePrompt(courseId)

  const [userPrompt, setUserPrompt] = useState("")
  const [modelId, setModelId] = useState(DEFAULT_LLM_MODEL_ID)
  const [conflictReport, setConflictReport] = useState(null)
  const [storedConflicts, setStoredConflicts] = useState(null)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const seededRef = useRef(false)

  useEffect(() => {
    if (promptData && !seededRef.current) {
      seededRef.current = true
      setUserPrompt(promptData.system_prompt || "")
      setModelId(promptData.llm_model_id || DEFAULT_LLM_MODEL_ID)
      if (promptData.conflict_metadata) setStoredConflicts(promptData.conflict_metadata)
    }
  }, [promptData])

  const activeReport = conflictReport ?? storedConflicts
  const hasConflicts = Boolean(activeReport?.has_conflicts)
  const overLimit = userPrompt.length > PROMPT_CHAR_LIMIT
  const dirty =
    userPrompt !== (promptData?.system_prompt ?? "") ||
    modelId !== (promptData?.llm_model_id ?? DEFAULT_LLM_MODEL_ID)

  const handlePromptChange = (e) => {
    setUserPrompt(e.target.value)
    // Editing invalidates any previously-computed conflicts.
    setConflictReport(null)
    setStoredConflicts(null)
  }

  const performSave = async (metadata) => {
    await save.mutateAsync({ prompt: userPrompt, llmModelId: modelId, conflictMetadata: metadata })
    setStoredConflicts(metadata?.has_conflicts ? metadata : null)
    setConflictReport(null)
    setOverrideOpen(false)
  }

  // Save runs the conflict check first (there's no separate "check" button):
  // no conflicts → save; conflicts → surface them inline and open the override
  // confirm before saving anyway. Reuses a report already computed for the
  // current prompt (cleared whenever the prompt is edited) so re-clicking Save
  // doesn't re-run the check. A failed check is best-effort — it never blocks
  // the save (matches the degradation path).
  const handleSave = async () => {
    let report = activeReport
    if (!report) {
      try {
        report = await validate.mutateAsync({ prompt: userPrompt, scope: "course" })
        setConflictReport(report)
      } catch {
        report = null
      }
    }
    if (report?.has_conflicts) {
      setOverrideOpen(true)
      return
    }
    performSave(null)
  }

  if (isLoading) {
    return <p className="text-caption text-muted-foreground">Loading settings…</p>
  }

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load settings"
        description={toUserMessage(error)}
        onRetry={() => refetch()}
      />
    )
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <UnsavedChangesPrompt when={dirty} />
      {/* Language model */}
      <section>
        <h3 className="text-caption font-semibold leading-7 text-neutral-900">Language model</h3>
        <p className="text-caption leading-7 text-muted-foreground">
          Choose which language model you&rsquo;d like to use for chatting with students and analyzing
          reference materials.
        </p>
        <LanguageModelDropdown
          value={modelId}
          onChange={setModelId}
          models={MODELS}
          aria-label="Language model"
          className="w-full"
        />
      </section>

      {/* System prompt (read-only) */}
      <section>
        <h3 className="text-caption font-semibold leading-7 text-neutral-900">System prompt</h3>
        <p className="text-caption leading-7 text-muted-foreground">
          This is the base system prompt applied to all courses. It cannot be edited.
        </p>
        <p className="whitespace-pre-wrap border border-border bg-background p-4 text-caption text-muted-foreground">
          {SYSTEM_LEVEL_PROMPT}
        </p>
      </section>

      {/* Your prompt (editable, with conflict check) */}
      <section>
        <h3 className="text-caption font-semibold leading-7 text-neutral-900">Your prompt</h3>
        <p className="text-caption leading-7 text-muted-foreground">
          <span className="font-semibold text-foreground">Warning:</span> Modifying the prompt in the text
          area below can significantly impact the quality and accuracy of the responses.
        </p>

        {hasConflicts && <ConflictWarning />}

        <Textarea
          className="p-4"
          value={userPrompt}
          onChange={handlePromptChange}
          rows={6}
          maxLength={PROMPT_CHAR_LIMIT}
          aria-label="Your prompt"
          aria-invalid={hasConflicts || overLimit || undefined}
          placeholder="Add course-specific instructions for the assistant…"
        />

        <div className="mt-2">
          <span className={cn("text-caption text-muted-foreground", overLimit && "text-destructive")}>
            {userPrompt.length}/{PROMPT_CHAR_LIMIT}
          </span>
        </div>

        <ConflictList report={activeReport} />
      </section>

      {/* View previous prompts (disclosure) */}
      <Accordion type="single" collapsible>
        {/* border-b-0 drops the AccordionItem's default bottom divider. */}
        <AccordionItem value="history" className="border-b-0">
          <AccordionTrigger className="text-caption font-semibold text-neutral-900 hover:no-underline">
            View previous prompts
          </AccordionTrigger>
          <AccordionContent>
            <PromptHistory
              versions={previousPrompts}
              onRestore={(text) => handlePromptChange({ target: { value: text } })}
            />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{toUserMessage(save.error)}</AlertDescription>
        </Alert>
      )}

      {/* Footer */}
      <div className="flex justify-end border-t border-border pt-4">
        <Button onClick={handleSave} loading={validate.isPending || save.isPending} disabled={!dirty}>
          Save changes
        </Button>
      </div>

      <ConfirmDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        title="Save with unresolved conflicts?"
        description="This prompt conflicts with other instructions. Saving anyway keeps the conflict flagged until you edit the prompt to resolve it."
        confirmLabel="Save anyway"
        variant="danger"
        loading={save.isPending}
        onConfirm={() => performSave(conflictReport ?? storedConflicts)}
      />
    </div>
  )
}
