import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { MdDelete, MdInsertDriveFile } from "react-icons/md"
import {
  useConcepts,
  useModules,
  useCourseFiles,
  useFinalizeModule,
  useValidatePrompt,
} from "@/services/queries"
import { useDraftModule } from "./hooks/useDraftModule"
import { useFileUpload } from "./hooks/useFileUpload"
import { useProcessingPoller } from "./hooks/useProcessingPoller"
import { useModuleTopics } from "./hooks/useModuleTopics"
import { shouldAutoGenerate, mergeTopics } from "@/utils/topicGenerationHelpers"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { BLOCKING_STATUSES } from "@/constants/uploadConfig"
import { FileUpload } from "@/components/composed/FileUpload"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Tag } from "@/components/composed/Tag"
import { EditableTagList } from "@/components/composed/EditableTagList"
import { ConflictList } from "@/components/composed/ConflictList"
import { ConflictWarning } from "@/components/composed/ConflictWarning"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { toUserMessage } from "@/services/apiError"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

// Step titles shown centred under the progress bar (Figma wizard frames).
const STEP_TITLES = [
  "Step 1: Set module name and concept",
  "Step 2: Attach and/or upload references",
  "Step 3: Assign module prompt and key topics",
  "Step 4: Review",
]
const STEP_COUNT = STEP_TITLES.length

/** Active (non-terminal) statuses whose label gets an animated ellipsis. The
 *  ellipsis is rendered separately, so these labels carry no trailing "…". */
const IN_PROGRESS_STATUSES = new Set([
  "uploading",
  "upload_complete",
  "pending",
  "ingesting",
  "enriching",
  "processing",
  "not_found",
])

/** Human-readable label for a per-file status. In-progress labels omit the
 *  trailing ellipsis — a static "…" is appended and the whole label glows
 *  (`animate-pulse-glow`) while work is ongoing. */
function statusLabel(status) {
  switch (status) {
    case "uploading":
      return "Uploading"
    case "upload_complete":
      return "Uploaded — processing"
    case "upload_failed":
      return "Upload failed"
    case "pending":
      return "Queued"
    case "ingesting":
      return "Reading document"
    case "enriching":
      return "Analyzing content"
    case "processing":
      return "Processing"
    case "complete":
      return "Complete"
    case "failed":
      return "Processing failed"
    case "not_found":
      return "Waiting"
    case "timed_out":
      return "Timed out"
    default:
      return status
  }
}

/** Bold label + value review row (Step 4). */
function ReviewRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-lg leading-7 font-semibold text-neutral-900">{label}</dt>
      <dd className="whitespace-pre-wrap text-caption leading-7 text-foreground">{children}</dd>
    </div>
  )
}

/**
 * Module create wizard — a centred modal (Figma `Create new module`) rendered
 * over the Configuration tab. 4 steps (Details -> References -> Prompt & topics
 * -> Review) with a determinate progress bar. Reserves a draft module on mount
 * so files upload before Save; files are ingested asynchronously (polled) and
 * Publish is gated until processing finishes. Finalize sets the module active,
 * then a module-scope prompt check runs (non-blocking).
 * Route: /instructor/courses/:courseId/configuration/modules/new.
 */
export function CourseWizard() {
  const { courseId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const { data: concepts = [] } = useConcepts(courseId)
  const { data: modules = [] } = useModules(courseId)
  const { data: courseFiles = [] } = useCourseFiles(courseId)
  const { moduleId, isReserving, reserveError, cleanup, markSaved } = useDraftModule(courseId)

  const [step, setStep] = useState(0)
  const [moduleName, setModuleName] = useState("")
  const [conceptId, setConceptId] = useState(searchParams.get("concept") || "")
  const [modulePrompt, setModulePrompt] = useState("")
  const [keyTopics, setKeyTopics] = useState([])
  const [suggestedTopics, setSuggestedTopics] = useState([]) // snapshot of auto-suggested topics (Suggest restores these)
  const [topicInput, setTopicInput] = useState("")
  const [referencedFileIds, setReferencedFileIds] = useState([])
  const [fileDescriptions, setFileDescriptions] = useState({}) // fileId -> description
  const [cancelOpen, setCancelOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [validating, setValidating] = useState(false) // on-click step validation in flight (freezes the step's fields)
  const [nameError, setNameError] = useState("") // step-0 inline error (duplicate module name within the concept)
  const [lastPromptCheck, setLastPromptCheck] = useState(null) // { prompt, hasConflicts } for the last checked prompt
  const [conflictWarnOpen, setConflictWarnOpen] = useState(false) // "proceed despite conflicts?" dialog
  const autoGenRef = useRef(false)

  const { fileStates, uploadFiles, removeFile } = useFileUpload({ courseId, moduleId, moduleName })
  const { trackedFiles, addTrackedFiles } = useProcessingPoller({ moduleId, enabled: Boolean(moduleId) })
  const { generate: generateTopics, isGenerating } = useModuleTopics(moduleId)
  const finalize = useFinalizeModule(courseId)
  const validate = useValidatePrompt(courseId)

  const fileList = Object.values(fileStates)
  const isProcessingBlocking = [...fileList, ...Object.values(trackedFiles)].some((f) =>
    BLOCKING_STATUSES.includes(f.status)
  )
  const uploadedCount = fileList.filter((f) => f.status === "upload_complete").length
  const canSave =
    Boolean(moduleId) &&
    !isProcessingBlocking &&
    moduleName.trim() &&
    conceptId &&
    fileList.length > 0 &&
    !finalize.isPending

  const otherFiles = useMemo(
    () => courseFiles.filter((f) => f.module_id !== moduleId),
    [courseFiles, moduleId]
  )
  const fileNameById = useMemo(() => {
    const map = new Map()
    for (const f of otherFiles) map.set(f.file_id, f.filename || f.file_id)
    return map
  }, [otherFiles])
  const attachableFiles = otherFiles.filter((f) => !referencedFileIds.includes(f.file_id))

  // Step-0 validation: does another module in the SAME concept already use this
  // name? Run on Next (not as a gate) so the user gets an inline reason. Checked
  // client-side against the loaded modules list — case-insensitive, trimmed,
  // excluding this draft. Some records carry only concept_name (no id), so fall
  // back to matching that. The server still enforces uniqueness on finalize.
  const selectedConceptName = concepts.find((c) => c.concept_id === conceptId)?.concept_name
  const isDuplicateName = useMemo(() => {
    const name = moduleName.trim().toLowerCase()
    if (!name) return false
    return modules.some((m) => {
      if (m.module_id === moduleId) return false
      const sameConcept = m.concept_id
        ? m.concept_id === conceptId
        : Boolean(selectedConceptName && m.concept_name === selectedConceptName)
      return sameConcept && (m.module_name || "").trim().toLowerCase() === name
    })
  }, [modules, moduleName, conceptId, moduleId, selectedConceptName])

  // Unsaved work in the draft. A pre-filled concept (from the ?concept= link)
  // isn't user input, so it only counts once changed. Uploaded files count —
  // leaving discards the reserved draft (cleanup below).
  const initialConcept = searchParams.get("concept") || ""
  const isDirty = Boolean(
    moduleName.trim() ||
      conceptId !== initialConcept ||
      modulePrompt.trim() ||
      keyTopics.length > 0 ||
      referencedFileIds.length > 0 ||
      fileList.length > 0
  )

  const handleGenerate = async () => {
    try {
      const result = await generateTopics()
      if (result?.topics) {
        // Topics generate in the background during the step-2 wait and just
        // appear (as tags) on step 3. Snapshot the suggested set so "Suggest"
        // can restore any topic the user removes.
        setKeyTopics((prev) => mergeTopics(prev, result.topics))
        setSuggestedTopics((prev) => mergeTopics(prev, result.topics))
      }
    } catch {
      // Advisory only — topic generation failures are non-blocking.
    }
  }

  // Auto-generate topics once all tracked files reach a terminal state.
  useEffect(() => {
    if (autoGenRef.current) return
    if (!shouldAutoGenerate(trackedFiles)) return
    autoGenRef.current = true
    handleGenerate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedFiles])

  const handleUpload = async (files) => {
    const results = await uploadFiles(files)
    const uploaded = results
      .filter((r) => r?.fileId)
      .map((r) => ({ fileId: r.fileId, uploadCompletedAt: Date.now() }))
    if (uploaded.length) addTrackedFiles(uploaded)
  }

  const addTopic = () => {
    const t = topicInput.trim()
    if (!t) return
    setKeyTopics((prev) => mergeTopics(prev, [t]))
    setTopicInput("")
  }

  // "Suggest" restores auto-suggested topics the user removed. It only activates
  // once at least one suggested topic is missing (deleted or edited away).
  const canRestoreSuggested = useMemo(() => {
    if (suggestedTopics.length === 0) return false
    const current = new Set(keyTopics.map((t) => t.toLowerCase().trim()))
    return suggestedTopics.some((t) => !current.has(t.toLowerCase().trim()))
  }, [suggestedTopics, keyTopics])

  const handleRestoreSuggested = () => setKeyTopics((prev) => mergeTopics(prev, suggestedTopics))

  const toggleReference = (fileId) =>
    setReferencedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    )

  const setFileDescription = (fileId, text) =>
    setFileDescriptions((prev) => ({ ...prev, [fileId]: text }))

  // Remove a file and drop any description held for it.
  const handleRemoveFile = (fileId) => {
    removeFile(fileId)
    setFileDescriptions((prev) => {
      if (!(fileId in prev)) return prev
      const rest = { ...prev }
      delete rest[fileId]
      return rest
    })
  }

  // Leave after a successful publish or a confirmed discard. Navigating from an
  // effect lets the guard see `when=false` first (leaving = true), so neither
  // path double-prompts on top of Publish / the wizard's own Discard confirm.
  useEffect(() => {
    if (leaving) navigate(`/instructor/courses/${courseId}/configuration`)
  }, [leaving, navigate, courseId])

  const handleCancel = async () => {
    setCancelOpen(false)
    await cleanup()
    setLeaving(true)
  }

  const handleSave = () => {
    finalize.mutate(
      {
        moduleId,
        conceptId,
        moduleName: moduleName.trim(),
        moduleNumber: modules.length + 1,
        modulePrompt,
        keyTopics,
        referencedFileIds,
        fileDescriptions: fileList
          .filter((f) => (fileDescriptions[f.fileId] || "").trim())
          .map((f) => ({ fileName: f.fileName, description: fileDescriptions[f.fileId].trim() })),
      },
      {
        onSuccess: () => {
          // The module-prompt conflict check runs earlier, on Next off the
          // prompt step (see handleNext) — not here.
          markSaved()
          setLeaving(true)
        },
      }
    )
  }

  // On Next the required-fields gate (`canNext`) has already passed; we then run
  // the step's validation with that step's fields frozen (`validating`):
  //   • Step 0 — block on a duplicate module name within the same concept.
  //   • Step 2 — block on the module-prompt conflict check (only when a prompt was
  //     entered — it's optional). No conflicts → advance. Conflicts → stay and
  //     surface an inline warning; a second Next (still unresolved) opens a confirm
  //     dialog whose "Okay" proceeds anyway.
  // Other steps have no post-gate validation, so they just advance.
  const handleNext = async () => {
    setValidating(true)
    try {
      if (step === 0) {
        if (isDuplicateName) {
          setNameError("A module with this name already exists in this concept.")
          return
        }
        setNameError("")
        setStep((s) => s + 1)
        return
      }

      if (step === 2) {
        const trimmed = modulePrompt.trim()
        if (!trimmed || !moduleId) {
          setStep((s) => s + 1)
          return
        }
        // Same prompt already checked — reuse the result (no repeat LLM call).
        if (lastPromptCheck && lastPromptCheck.prompt === trimmed) {
          if (lastPromptCheck.report?.has_conflicts) setConflictWarnOpen(true)
          else setStep((s) => s + 1)
          return
        }
        // New/changed prompt → run the check. Next shows a spinner and blocks.
        try {
          const report = await validate.mutateAsync({ prompt: trimmed, scope: "module", moduleId })
          setLastPromptCheck({ prompt: trimmed, report })
          if (!report?.has_conflicts) setStep((s) => s + 1)
          // else: stay — the inline Alert appears; a re-click opens the confirm dialog.
        } catch {
          // Advisory only — a validation failure must not trap the user on the step.
          setStep((s) => s + 1)
        }
        return
      }

      // Step 1 (and any others): the required-fields gate is the only requirement.
      setStep((s) => s + 1)
    } finally {
      setValidating(false)
    }
  }

  // "Okay" on the conflict warning → proceed to the next step.
  const proceedPastConflicts = () => {
    setConflictWarnOpen(false)
    setStep((s) => s + 1)
  }

  // Required-fields gate — Next stays disabled until the current step's required
  // inputs are present. Post-gate validation (duplicate name, prompt conflicts)
  // runs in handleNext once the button is clicked.
  //   • Step 0 — a module name and a selected concept.
  //   • Step 1 — at least one uploaded file, none still processing. Keeps the user
  //     here until ingestion finishes (files ingest + topics auto-generate during
  //     this wait, so step 3 opens with topics ready and the user waits only once).
  //   • Step 2 — at least one key topic.
  const canNext =
    step === 0
      ? Boolean(moduleName.trim() && conceptId)
      : step === 1
        ? uploadedCount > 0 && !isProcessingBlocking
        : step === 2
          ? keyTopics.length > 0
          : true

  // Conflicts from the last check, but only while they still describe the prompt
  // currently in the textarea (editing invalidates them → re-check on next Next).
  const promptConflictReport =
    lastPromptCheck && lastPromptCheck.prompt === modulePrompt.trim() && lastPromptCheck.report?.has_conflicts
      ? lastPromptCheck.report
      : null

  return (
    <>
      <UnsavedChangesPrompt when={isDirty && !leaving} onProceed={cleanup} />
      <Dialog open onOpenChange={(open) => !open && setCancelOpen(true)}>
        {/* Figma `Modal/Admin/AddModule` (node 1141:6789): explicit height 90vh
            (floored at 640px, capped at 90vh). The header (title + progress) and
            footer (actions) stay fixed; only the body between them scrolls.
            Full-bleed (`p-0`) — each region pads itself to the modal's 36px
            (px-9) gutter. */}
        <DialogContent className="flex h-[90vh] min-h-[640px] max-h-[90vh] w-[min(92vw,1088px)] max-w-none flex-col gap-0 overflow-hidden p-0">
          {/* Fixed header: title + divider (pt-14 clears the close control),
              then the determinate progress bar (16px track, #D9D9D9). */}
          <div className="shrink-0">
            <div className="flex flex-col gap-2 px-9 pt-14">
              <DialogTitle>Create new module</DialogTitle>
              <div className="h-px w-full bg-border" aria-hidden="true" />
            </div>
            <div className="px-9 pt-10">
              <Progress className="h-4 bg-neutral-200" value={((step + 1) / STEP_COUNT) * 100} />
            </div>
          </div>

          {/* Scrollable body. Content sits in a 608px column, centred so it
              clears the modal's 240px side inset at the design width. `flex-1`
              fills the space left by the fixed header/footer; `min-h-0` +
              `overflow-y-auto` scroll the overflow within the modal's fixed
              height. */}
          <div className="flex-1 min-h-0 overflow-y-auto px-9 pb-16 pt-14">
            <div className="mx-auto flex w-full max-w-[608px] flex-col gap-8">
              <h2 className="text-h3 text-neutral-900">{STEP_TITLES[step]}</h2>

              {reserveError && (
                <Alert variant="destructive">
                  <AlertTitle>Couldn&rsquo;t start a new module</AlertTitle>
                  <AlertDescription>{reserveError}</AlertDescription>
                </Alert>
              )}

              {step === 0 && (
                <div className="flex flex-col gap-9">
                  <div className="flex flex-col">
                    <Label htmlFor="module-name" className="text-h4 text-neutral-900">Module name</Label>
                    <Input
                      id="module-name"
                      value={moduleName}
                      onChange={(e) => {
                        setModuleName(e.target.value)
                        if (nameError) setNameError("")
                      }}
                      maxLength={100}
                      placeholder="e.g. Vectors and matrices"
                      disabled={validating}
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={nameError ? "module-name-error" : undefined}
                    />
                    {nameError && (
                      <p id="module-name-error" className="mt-1 text-caption text-destructive">
                        {nameError}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col">
                    <Label className="text-h4 text-neutral-900">Concept</Label>
                    <Select
                      value={conceptId}
                      onValueChange={(v) => {
                        setConceptId(v)
                        if (nameError) setNameError("")
                      }}
                      disabled={validating}
                    >
                      <SelectTrigger aria-label="Concept">
                        <SelectValue placeholder="Select a concept" />
                      </SelectTrigger>
                      <SelectContent>
                        {concepts.map((c) => (
                          <SelectItem key={c.concept_id} value={c.concept_id}>
                            {titleCase(c.concept_name)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {step === 1 && (
                <div className="flex flex-col gap-8">
                  <div className="flex flex-col">
                    <div className="flex items-center justify-between">
                      <Label className="text-body text-neutral-900">Attach existing references</Label>
                      <span className="text-caption text-muted-foreground">(optional)</span>
                    </div>
                    <p className="text-caption text-muted-foreground">
                      Reference files from this course&rsquo;s other modules.
                    </p>
                    <Select
                      value=""
                      onValueChange={toggleReference}
                      disabled={validating || attachableFiles.length === 0}
                    >
                      <SelectTrigger aria-label="Attach existing reference">
                        <SelectValue
                          placeholder={
                            attachableFiles.length === 0 ? "No other files available" : "Select a file to attach"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {attachableFiles.map((f) => (
                          <SelectItem key={f.file_id} value={f.file_id}>
                            {(f.filename || f.file_id) + (f.module_name ? ` — ${titleCase(f.module_name)}` : "")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {referencedFileIds.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {referencedFileIds.map((id) => (
                          <Tag
                            key={id}
                            label={fileNameById.get(id) || id}
                            onRemove={() => toggleReference(id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col">
                    <div className="flex items-center justify-between">
                      <Label className="text-body text-neutral-900">Upload files</Label>
                    </div>
                    <p className="text-caption text-muted-foreground mb-2">
                      To add new references, upload your files below.
                    </p>
                    <FileUpload onFiles={handleUpload} disabled={validating || !moduleId || isReserving} />

                    {fileList.length > 0 && (
                      <div className="mt-8 flex flex-col">
                        <p className="text-lg leading-7 font-semibold text-neutral-900">Uploaded files</p>
                        <ul className="flex flex-col gap-2">
                          {fileList.map((f) => {
                            const tracked = trackedFiles[f.fileId]
                            const status = tracked?.status ?? f.status
                            const failed = status === "upload_failed" || status === "failed"
                            // Description accordion (Figma node 1162:8419): shown once the file
                            // has uploaded and isn't in a failed state.
                            const showDescription = !failed && status !== "uploading"
                            return (
                              <li key={f.fileId} className="flex flex-col gap-2 rounded-sm border border-border p-2.5">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="flex min-w-0 items-center gap-3">
                                    <Icon
                                      icon={MdInsertDriveFile}
                                      size={20}
                                      className="shrink-0 text-muted-foreground"
                                    />
                                    <div className="flex min-w-0 flex-col">
                                      <span className="truncate text-xs leading-7 font-semibold text-neutral-900">
                                        {f.fileName}
                                      </span>
                                      <span
                                        className={cn(
                                          "text-xs leading-7",
                                          failed
                                            ? "text-destructive"
                                            : status === "complete"
                                              ? "text-success"
                                              : "text-muted-foreground",
                                          IN_PROGRESS_STATUSES.has(status) &&
                                            "animate-pulse-glow motion-reduce:animate-none"
                                        )}
                                      >
                                        {IN_PROGRESS_STATUSES.has(status)
                                          ? `${statusLabel(status)}…`
                                          : statusLabel(status)}
                                      </span>
                                    </div>
                                  </div>
                                  <Button
                                    className="gap-0 w-6 h-6"
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Remove ${f.fileName}`}
                                    onClick={() => handleRemoveFile(f.fileId)}
                                  >
                                    <Icon  icon={MdDelete} size={24} />
                                  </Button>
                                </div>
                                {showDescription && (
                                  <Accordion type="single" collapsible>
                                    <AccordionItem value="description" className="border-b-0">
                                      <AccordionTrigger className="py-0 font-normal leading-7 text-neutral-900 hover:no-underline">
                                        Description (optional)
                                      </AccordionTrigger>
                                      <AccordionContent className="pb-0 pt-2">
                                        <Textarea
                                          value={fileDescriptions[f.fileId] || ""}
                                          onChange={(e) => setFileDescription(f.fileId, e.target.value)}
                                          rows={3}
                                          placeholder="Add an optional description for this file…"
                                          aria-label={`Description for ${f.fileName}`}
                                        />
                                      </AccordionContent>
                                    </AccordionItem>
                                  </Accordion>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="module-prompt" className="text-body text-neutral-900">Module prompt</Label>
                    <span className="text-caption text-muted-foreground">(optional)</span>
                  </div>
                  <p className="text-caption leading-7 text-muted-foreground">
                    Provide any specific instructions for this module, which will be used with the
                    course-level prompt.
                  </p>
                  {/* Figma AddModule/Step3/A conflict state: red banner above the
                      prompt, red-bordered textarea, and the collapsible conflict
                      rows below. */}
                  <div className="flex flex-col gap-2">
                    {promptConflictReport && <ConflictWarning />}
                    <Textarea
                      id="module-prompt"
                      value={modulePrompt}
                      onChange={(e) => setModulePrompt(e.target.value)}
                      rows={5}
                      disabled={validating}
                      aria-invalid={promptConflictReport ? true : undefined}
                      placeholder="Module-specific instructions for the assistant…"
                    />
                    <ConflictList report={promptConflictReport} />
                  </div>

                  <div className="flex flex-col mt-9">
                    <Label className="text-body text-neutral-900">Key topics</Label>
                    <p className="text-caption leading-7 text-muted-foreground mb-8">
                      OCELIA automatically suggests key topics based on your uploaded files. You can
                      add/remove a topic or edit an existing one by clicking it below. To restore any
                      previously suggested topics, click the &lsquo;Suggest&rsquo; button.
                    </p>
                    <div className="flex gap-4 mb-8">
                      {/* Inactive: #808080 border+text (solid, not faded). Active:
                          the outline variant's #6829C2 border+text. */}
                      <Button
                        className="rounded disabled:border-neutral-500 disabled:text-neutral-500 disabled:opacity-100"
                        variant="outline"
                        onClick={handleRestoreSuggested}
                        loading={isGenerating}
                        disabled={validating || !canRestoreSuggested}
                      >
                        Suggest
                      </Button>
                      <Input
                        value={topicInput}
                        onChange={(e) => setTopicInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            addTopic()
                          }
                        }}
                        placeholder="Add new…"
                        aria-label="Add key topic"
                        className="flex-1 rounded"
                        disabled={validating}
                      />
                    </div>
                    <EditableTagList
                      values={keyTopics}
                      onChange={setKeyTopics}
                      ariaLabelPrefix="key topic"
                      disabled={validating}
                    />
                  </div>
                </div>
              )}

              {step === 3 && (
                <dl className="flex flex-col gap-6">
                  <ReviewRow label="Module name">{moduleName || "—"}</ReviewRow>
                  <ReviewRow label="Concept">
                    {titleCase(concepts.find((c) => c.concept_id === conceptId)?.concept_name || "—")}
                  </ReviewRow>
                  {referencedFileIds.length > 0 && (
                    <ReviewRow label="Reference">
                      {referencedFileIds.map((id) => fileNameById.get(id) || id).join(", ")}
                    </ReviewRow>
                  )}
                  <ReviewRow label="Uploaded files">
                    {fileList.length
                      ? fileList.map((f) => f.fileName).join("\n") +
                        (isProcessingBlocking ? "\n(still processing…)" : "")
                      : "None"}
                  </ReviewRow>
                  <ReviewRow label="Module prompt">{modulePrompt || "—"}</ReviewRow>
                  <ReviewRow label="Key topics">{keyTopics.length ? keyTopics.join("; ") : "None"}</ReviewRow>
                  {!canSave && !finalize.isPending && (
                    <p className="text-caption text-muted-foreground">
                      {isProcessingBlocking
                        ? "Waiting for file processing to finish before you can publish the module."
                        : "Add a name, concept, and at least one file to publish the module."}
                    </p>
                  )}
                </dl>
              )}
            </div>
          </div>

          {/* Fixed footer: divider + actions. Back floats left (from step 2
              onward); Cancel + the primary action (Next, or Publish on the final
              step) sit on the right. */}
          <div className="shrink-0 px-9 pb-9">
            <div className="flex flex-col gap-4">
              {finalize.isError && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {toUserMessage(finalize.error, {
                      400: "A module with this name already exists.",
                      409: "Files are still being processed — try again shortly.",
                    })}
                  </AlertDescription>
                </Alert>
              )}
              <div className="h-px w-full bg-border" aria-hidden="true" />
              <div className="flex items-center justify-between gap-2">
                {/* Left slot: Back (empty on step 1 keeps the right group pinned). */}
                <div>
                  {step > 0 && (
                    <Button
                      variant="ghost"
                      className="text-primary text-base"
                      disabled={validating}
                      onClick={() => setStep((s) => s - 1)}
                    >
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button className="text-base" variant="outline" onClick={() => setCancelOpen(true)}>
                    Cancel
                  </Button>
                  {step < STEP_COUNT - 1 ? (
                    <Button
                      className="text-base hover:bg-primary-dark"
                      onClick={handleNext}
                      loading={validating}
                      disabled={!canNext}
                    >
                      Next
                    </Button>
                  ) : (
                    <Button
                      className="text-base hover:bg-primary-dark"
                      onClick={handleSave}
                      loading={finalize.isPending}
                      disabled={!canSave}
                    >
                      Publish
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Discard this module?"
        description="Your uploaded files and progress for this draft will be discarded."
        confirmLabel="Discard"
        variant="danger"
        onConfirm={handleCancel}
      />

      <ConfirmDialog
        open={conflictWarnOpen}
        onOpenChange={setConflictWarnOpen}
        title="Prompt conflicts detected"
        description="This module prompt may conflict with the course or system prompt. You can go back and revise it, or continue anyway."
        confirmLabel="Okay"
        cancelLabel="Cancel"
        variant="default"
        onConfirm={proceedPastConflicts}
      />
    </>
  )
}
