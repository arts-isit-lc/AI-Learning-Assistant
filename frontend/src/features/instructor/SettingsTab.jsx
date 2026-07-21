import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { useCoursePrompt, usePreviousPrompts, useValidatePrompt, useSavePrompt } from "@/services/queries"
import { LLM_MODELS, DEFAULT_LLM_MODEL_ID } from "@/constants/llmModels"
import { SYSTEM_LEVEL_PROMPT } from "@/constants/systemPrompt"
import { cn } from "@/lib/utils"
import { LanguageModelDropdown } from "@/components/composed/LanguageModelDropdown"
import { PromptHistory } from "@/components/composed/PromptHistory"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
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

function isModuleSource(src) {
  return typeof src === "string" && src.startsWith("module_prompt:")
}

/** Human label for a prompt source ("system_prompt" -> "System prompt"). */
function sourceLabel(src) {
  if (src === "course_prompt") return "Course prompt"
  if (src === "system_prompt") return "System prompt"
  if (isModuleSource(src)) return `Module: ${src.replace("module_prompt:", "")}`
  return src || "Prompt"
}

/** The prompt this one clashes WITH (the non-course side), for the row summary. */
function conflictWith(conflict) {
  const other =
    [conflict.prompt_a_source, conflict.prompt_b_source].find((s) => s && s !== "course_prompt") ||
    conflict.prompt_b_source ||
    conflict.prompt_a_source
  if (other === "system_prompt") return "system level prompt"
  if (isModuleSource(other)) return `module: ${other.replace("module_prompt:", "")}`
  return other || "another prompt"
}

// Display labels for the four backend conflict types (UBC/Canadian spelling per
// the Figma frames). Only HARD_CONTRADICTION is rendered red; the rest mustard.
const TYPE_LABELS = {
  HARD_CONTRADICTION: "HARD CONTRADICTION",
  BEHAVIORAL_INCOMPATIBILITY: "BEHAVIOURAL INCOMPATIBILITY",
  CONSTRAINT_COLLISION: "CONSTRAINT COLLISION",
  HIERARCHY_VIOLATION: "HIERARCHY VIOLATION",
}

/** Figma severity pill label for a conflict type (falls back to a spaced enum). */
function severityLabel(conflict) {
  return TYPE_LABELS[conflict.type] || String(conflict.type || "CONFLICT").replace(/_/g, " ")
}

/**
 * The conflict list under the prompt (Figma Settings/C): each conflict is a
 * collapsible row — a solid severity pill + "Conflicts with: <source>" — that
 * expands to the explanation and the two clashing prompt texts. A low-confidence
 * toggle reveals softer, model-only matches.
 */
function ConflictList({ report, showLowConfidence, onToggleLowConfidence }) {
  if (!report?.has_conflicts) return null
  const all = report.conflicts || []
  const visible = all.filter((c) => showLowConfidence || c.severity !== "low_confidence_llm")
  const lowConfidenceCount = all.filter((c) => c.severity === "low_confidence_llm").length
  if (visible.length === 0 && lowConfidenceCount === 0) return null

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Accordion type="multiple" className="flex flex-col gap-2">
        {visible.map((c, i) => (
          <AccordionItem key={i} value={String(i)} className="border-b-0">
            <AccordionTrigger className="gap-3 py-1 hover:no-underline">
              <span className="flex flex-1 items-center gap-3 text-left">
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-0.5 text-caption font-semibold uppercase",
                    c.type === "HARD_CONTRADICTION"
                      ? "bg-destructive text-destructive-foreground"
                      : "bg-warning text-warning-foreground"
                  )}
                >
                  {severityLabel(c)}
                </span>
                <span className="text-caption text-foreground">
                  Conflicts with: <span className="font-semibold">{conflictWith(c)}</span>
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              {c.explanation && <p className="mb-2 text-caption text-foreground">{c.explanation}</p>}
              {c.prompt_a_text && (
                <p className="text-caption text-muted-foreground">
                  <span className="font-semibold">{sourceLabel(c.prompt_a_source)}:</span> {c.prompt_a_text}
                </p>
              )}
              {c.prompt_b_text && (
                <p className="text-caption text-muted-foreground">
                  <span className="font-semibold">{sourceLabel(c.prompt_b_source)}:</span> {c.prompt_b_text}
                </p>
              )}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      {lowConfidenceCount > 0 && (
        <Button variant="link" size="sm" className="self-start px-0" onClick={onToggleLowConfidence}>
          {showLowConfidence
            ? "Hide low-confidence conflicts"
            : `Show ${lowConfidenceCount} low-confidence conflict(s)`}
        </Button>
      )}
    </div>
  )
}

/**
 * Settings tab — Figma 376:2480 / 771:5650. Flat sections (not cards): Language
 * model, the read-only System prompt, then the editable course ("Your") prompt
 * with an explicit **Check for conflicts** action, a **View previous prompts**
 * disclosure, and a footer **Save changes**.
 *
 * Conflict flow: "Check for conflicts" runs validation and renders the results
 * inline (red alert + red textarea + severity rows). "Save changes" persists;
 * if the checked prompt still has conflicts it asks to confirm before saving
 * anyway (which stores conflict_metadata, keeping the Settings tab dot lit until
 * the prompt is edited and re-saved conflict-free). Saving is allowed without
 * checking (validation is best-effort, matching the degradation path).
 */
export function SettingsTab() {
  const { courseId } = useParams()
  const { data: promptData, isLoading } = useCoursePrompt(courseId)
  const { data: previousPrompts = [] } = usePreviousPrompts(courseId)
  const validate = useValidatePrompt(courseId)
  const save = useSavePrompt(courseId)

  const [userPrompt, setUserPrompt] = useState("")
  const [modelId, setModelId] = useState(DEFAULT_LLM_MODEL_ID)
  const [conflictReport, setConflictReport] = useState(null)
  const [storedConflicts, setStoredConflicts] = useState(null)
  const [showLowConfidence, setShowLowConfidence] = useState(false)
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

  const handleCheck = async () => {
    try {
      const report = await validate.mutateAsync({ prompt: userPrompt, scope: "course" })
      setConflictReport(report)
      if (!report?.has_conflicts) toast.success("No conflicts found")
    } catch {
      toast.error("Couldn't check for conflicts. You can still save.")
    }
  }

  const performSave = async (metadata) => {
    await save.mutateAsync({ prompt: userPrompt, llmModelId: modelId, conflictMetadata: metadata })
    setStoredConflicts(metadata?.has_conflicts ? metadata : null)
    setConflictReport(null)
    setOverrideOpen(false)
    toast.success("Settings saved")
  }

  const handleSave = () => {
    if (hasConflicts) {
      setOverrideOpen(true)
      return
    }
    performSave(null)
  }

  if (isLoading) {
    return <p className="text-caption text-muted-foreground">Loading settings…</p>
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {/* Language model */}
      <section>
        <h3 className="text-caption font-semibold text-neutral-900">Language model</h3>
        <p className="mt-1 text-caption text-muted-foreground">
          Choose which language model you&rsquo;d like to use for chatting with students and analyzing
          reference materials.
        </p>
        <LanguageModelDropdown
          value={modelId}
          onChange={setModelId}
          models={MODELS}
          aria-label="Language model"
          className="mt-3 w-full"
        />
      </section>

      {/* System prompt (read-only) */}
      <section>
        <h3 className="text-caption font-semibold text-neutral-900">System prompt</h3>
        <p className="mt-1 text-caption text-muted-foreground">
          This is the base system prompt applied to all courses. It cannot be edited.
        </p>
        <p className="mt-3 whitespace-pre-wrap rounded-sm border border-border bg-background p-4 text-caption text-muted-foreground">
          {SYSTEM_LEVEL_PROMPT}
        </p>
      </section>

      {/* Your prompt (editable, with conflict check) */}
      <section>
        <h3 className="text-caption font-semibold text-neutral-900">Your prompt</h3>
        <p className="mt-1 text-caption text-muted-foreground">
          <span className="font-semibold text-foreground">Warning:</span> Modifying the prompt in the text
          area below can significantly impact the quality and accuracy of the responses.
        </p>

        {hasConflicts && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>There are conflicts. Please resolve below.</AlertDescription>
          </Alert>
        )}

        <Textarea
          className="mt-3"
          value={userPrompt}
          onChange={handlePromptChange}
          rows={6}
          maxLength={PROMPT_CHAR_LIMIT}
          aria-label="Your prompt"
          aria-invalid={hasConflicts || overLimit || undefined}
          placeholder="Add course-specific instructions for the assistant…"
        />

        <div className="mt-2 flex items-center justify-between gap-3">
          <span className={cn("text-caption text-muted-foreground", overLimit && "text-destructive")}>
            {userPrompt.length}/{PROMPT_CHAR_LIMIT}
          </span>
          <Button variant="outline" onClick={handleCheck} loading={validate.isPending}>
            Check for conflicts
          </Button>
        </div>

        <ConflictList
          report={activeReport}
          showLowConfidence={showLowConfidence}
          onToggleLowConfidence={() => setShowLowConfidence((s) => !s)}
        />
      </section>

      {/* View previous prompts (disclosure) */}
      <Accordion type="single" collapsible>
        <AccordionItem value="history" className="border-t border-border">
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

      {/* Footer */}
      <div className="flex justify-end border-t border-border pt-4">
        <Button onClick={handleSave} loading={save.isPending} disabled={!dirty}>
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
