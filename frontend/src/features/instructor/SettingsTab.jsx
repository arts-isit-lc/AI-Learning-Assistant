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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
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
function moduleNameOf(conflict) {
  const src = [conflict.prompt_a_source, conflict.prompt_b_source].find(isModuleSource) || ""
  return src.replace("module_prompt:", "")
}

/** One conflict entry: explanation + the two clashing sources/texts. */
function ConflictItem({ conflict }) {
  const hard = conflict.type === "HARD_CONTRADICTION"
  return (
    <li className="rounded-md border border-border p-3">
      <div className="mb-1 flex items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-caption font-semibold",
            hard ? "bg-destructive-muted text-destructive-muted-foreground" : "bg-warning/15 text-warning"
          )}
        >
          {hard ? "Contradiction" : "Possible conflict"}
        </span>
      </div>
      {conflict.explanation && <p className="mb-2 text-caption text-foreground">{conflict.explanation}</p>}
      {conflict.prompt_a_text && (
        <p className="text-caption text-muted-foreground">
          <span className="font-semibold">{conflict.prompt_a_source}:</span> {conflict.prompt_a_text}
        </p>
      )}
      {conflict.prompt_b_text && (
        <p className="text-caption text-muted-foreground">
          <span className="font-semibold">{conflict.prompt_b_source}:</span> {conflict.prompt_b_text}
        </p>
      )}
    </li>
  )
}

/** Grouped conflict display (course-level list + per-module accordions + low-confidence toggle). */
function ConflictReportView({ report, showLowConfidence, onToggleLowConfidence }) {
  if (!report?.has_conflicts) return null
  const all = report.conflicts || []
  const visible = all.filter((c) => showLowConfidence || c.severity !== "low_confidence_llm")
  const courseConflicts = visible.filter(
    (c) => c.prompt_a_source === "course_prompt" || c.prompt_b_source === "course_prompt"
  )
  const moduleConflicts = visible.filter(
    (c) => isModuleSource(c.prompt_a_source) || isModuleSource(c.prompt_b_source)
  )
  const lowConfidenceCount = all.filter((c) => c.severity === "low_confidence_llm").length

  const byModule = {}
  for (const c of moduleConflicts) {
    const name = moduleNameOf(c)
    ;(byModule[name] ||= []).push(c)
  }
  const moduleNames = Object.keys(byModule)

  return (
    <div className="rounded-md border border-warning/50 bg-warning/10 p-4">
      <p className="mb-3 font-semibold text-foreground">
        {report.summary || `${visible.length} potential conflict(s) found`}
      </p>

      {courseConflicts.length > 0 && (
        <div className="mb-3">
          <p className="mb-2 text-caption font-semibold text-foreground">Course prompt</p>
          <ul className="flex flex-col gap-2">
            {courseConflicts.map((c, i) => (
              <ConflictItem key={`course-${i}`} conflict={c} />
            ))}
          </ul>
        </div>
      )}

      {moduleNames.length > 0 && (
        <Accordion type="multiple" className="mb-1">
          {moduleNames.map((name) => (
            <AccordionItem key={name} value={name}>
              <AccordionTrigger>
                {name} ({byModule[name].length})
              </AccordionTrigger>
              <AccordionContent>
                <ul className="flex flex-col gap-2">
                  {byModule[name].map((c, i) => (
                    <ConflictItem key={`${name}-${i}`} conflict={c} />
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}

      {lowConfidenceCount > 0 && (
        <Button variant="link" size="sm" className="px-0" onClick={onToggleLowConfidence}>
          {showLowConfidence
            ? "Hide low-confidence conflicts"
            : `Show ${lowConfidenceCount} low-confidence conflict(s)`}
        </Button>
      )}
    </div>
  )
}

/**
 * Settings tab — model + system prompt with conflict-check-on-save. There is no
 * separate "check" button: Save validates first; on conflict it blocks and shows
 * the conflicts (Save stays enabled); clicking Save again opens an override
 * confirm and saves anyway (persisting conflict_metadata, which keeps the tab
 * dot lit until the prompt is edited conflict-free).
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
  const validatedPromptRef = useRef(null)
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
  const busy = validate.isPending || save.isPending

  const handlePromptChange = (e) => {
    setUserPrompt(e.target.value)
    validatedPromptRef.current = null // force re-validation on next Save
    setConflictReport(null)
  }

  const performSave = async (metadata) => {
    await save.mutateAsync({ prompt: userPrompt, llmModelId: modelId, conflictMetadata: metadata })
    setStoredConflicts(metadata?.has_conflicts ? metadata : null)
    if (!metadata) setConflictReport(null)
    setOverrideOpen(false)
    toast.success("Settings saved")
  }

  const handleSave = async () => {
    const alreadyValidated = validatedPromptRef.current === userPrompt

    if (!alreadyValidated) {
      let report
      try {
        report = await validate.mutateAsync({ prompt: userPrompt, scope: "course" })
      } catch {
        // Validation unavailable — allow the save (legacy degradation).
        setConflictReport(null)
        await performSave(null)
        return
      }
      validatedPromptRef.current = userPrompt
      setConflictReport(report)
      if (report?.has_conflicts) return // block: show conflicts, let the user re-Save to override
      await performSave(null)
      return
    }

    // Already validated for the current text.
    if (conflictReport?.has_conflicts) {
      setOverrideOpen(true)
      return
    }
    await performSave(null)
  }

  if (isLoading) {
    return <p className="text-caption text-muted-foreground">Loading settings…</p>
  }

  const overLimit = userPrompt.length > PROMPT_CHAR_LIMIT

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Language model</CardTitle>
        </CardHeader>
        <CardContent>
          <LanguageModelDropdown
            value={modelId}
            onChange={setModelId}
            models={MODELS}
            aria-label="Language model"
            className="max-w-sm"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Course prompt</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="course-prompt">Instructor prompt</Label>
            <Textarea
              id="course-prompt"
              value={userPrompt}
              onChange={handlePromptChange}
              rows={8}
              maxLength={PROMPT_CHAR_LIMIT}
              aria-invalid={overLimit || undefined}
              placeholder="Add course-specific instructions for the assistant…"
            />
            <span className={cn("self-end text-caption text-muted-foreground", overLimit && "text-destructive")}>
              {userPrompt.length}/{PROMPT_CHAR_LIMIT}
            </span>
          </div>

          <ConflictReportView
            report={activeReport}
            showLowConfidence={showLowConfidence}
            onToggleLowConfidence={() => setShowLowConfidence((s) => !s)}
          />
          {activeReport?.has_conflicts && (
            <p className="text-caption text-muted-foreground">
              Resolve the conflicts above, or click Save again to save anyway.
            </p>
          )}

          <div>
            <Button onClick={handleSave} loading={busy}>
              Save changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System prompt</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-caption text-muted-foreground">
            Fixed instructions applied to every course. Read-only.
          </p>
          <p className="whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
            {SYSTEM_LEVEL_PROMPT}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Prompt history</CardTitle>
        </CardHeader>
        <CardContent>
          <PromptHistory versions={previousPrompts} onRestore={(text) => handlePromptChange({ target: { value: text } })} />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        title="Save with unresolved conflicts?"
        description="This prompt conflicts with other instructions. Saving anyway keeps the conflict flagged until you edit the prompt to resolve it."
        confirmLabel="Save anyway"
        variant="danger"
        loading={save.isPending}
        onConfirm={() => performSave(conflictReport)}
      />
    </div>
  )
}
