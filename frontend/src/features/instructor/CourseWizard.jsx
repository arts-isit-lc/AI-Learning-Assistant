import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "react-toastify"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
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

/** Human-readable label for a per-file status. */
function statusLabel(status) {
  switch (status) {
    case "uploading":
      return "Uploading…"
    case "upload_complete":
      return "Uploaded — processing…"
    case "upload_failed":
      return "Upload failed"
    case "pending":
    case "processing":
      return "Processing…"
    case "complete":
      return "Ready"
    case "failed":
      return "Processing failed"
    case "not_found":
      return "Waiting…"
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
      <dt className="text-caption font-semibold text-neutral-900">{label}</dt>
      <dd className="whitespace-pre-wrap text-caption text-foreground">{children}</dd>
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
  const [topicInput, setTopicInput] = useState("")
  const [referencedFileIds, setReferencedFileIds] = useState([])
  const [cancelOpen, setCancelOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
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
      if (result?.status === "processing") {
        toast.info(`Topics still processing (${result.ready}/${result.total} files). Try again shortly.`)
      } else if (result?.status === "no_files") {
        toast.info("No files uploaded yet.")
      } else if (result?.status === "error") {
        toast.error(result.message || "Failed to generate topics")
      } else if (result?.topics) {
        setKeyTopics((prev) => mergeTopics(prev, result.topics))
        toast.success("Topics generated")
      }
    } catch {
      toast.error("Failed to generate topics")
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

  const toggleReference = (fileId) =>
    setReferencedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    )

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
      },
      {
        onSuccess: async () => {
          markSaved()
          if (modulePrompt.trim()) {
            try {
              const report = await validate.mutateAsync({
                prompt: modulePrompt,
                scope: "module",
                moduleId,
              })
              if (report?.has_conflicts) {
                toast.info("Module saved. Prompt conflicts were detected — review them in Settings.")
              }
            } catch {
              // Non-blocking — the module is already saved.
            }
          }
          toast.success("Module created")
          setLeaving(true)
        },
        onError: (err) => {
          if (err?.status === 400) toast.error("A module with this name already exists")
          else if (err?.status === 409) toast.error("Files are still being processed")
          else toast.error("Failed to create module")
        },
      }
    )
  }

  const canNext =
    step === 0 ? Boolean(moduleName.trim() && conceptId) : step === 1 ? uploadedCount > 0 : true

  return (
    <>
      <UnsavedChangesPrompt when={isDirty && !leaving} onProceed={cleanup} />
      <Dialog open onOpenChange={(open) => !open && setCancelOpen(true)}>
        <DialogContent className="flex max-h-[90vh] w-[min(92vw,1200px)] max-w-none flex-col gap-0 p-0">
          <div className="px-8 pb-3 pt-6">
            <DialogTitle className="text-h4 font-semibold text-neutral-900">Create new module</DialogTitle>
          </div>
          <Progress value={((step + 1) / STEP_COUNT) * 100} className="mx-8 h-2 shrink-0" />

          <div className="flex-1 overflow-y-auto px-8 py-8">
            <div className="mx-auto flex max-w-xl flex-col gap-8">
              <h2 className="text-body font-semibold text-neutral-900">{STEP_TITLES[step]}</h2>

              {reserveError && (
                <Alert variant="destructive">
                  <AlertTitle>Couldn&rsquo;t start a new module</AlertTitle>
                  <AlertDescription>{reserveError}</AlertDescription>
                </Alert>
              )}

              {step === 0 && (
                <div className="flex flex-col gap-6">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="module-name" className="text-neutral-900">Module name</Label>
                    <Input
                      id="module-name"
                      value={moduleName}
                      onChange={(e) => setModuleName(e.target.value)}
                      maxLength={100}
                      placeholder="e.g. Vectors and matrices"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col gap-0.5">
                      <Label className="text-neutral-900">Concept</Label>
                      <p className="text-caption text-muted-foreground">Select a Concept for this module.</p>
                    </div>
                    <Select value={conceptId} onValueChange={setConceptId}>
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
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-neutral-900">Attach existing references</Label>
                      <span className="text-caption text-muted-foreground">(optional)</span>
                    </div>
                    <p className="text-caption text-muted-foreground">
                      Reference files from this course&rsquo;s other modules.
                    </p>
                    <Select value="" onValueChange={toggleReference} disabled={attachableFiles.length === 0}>
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
                      <div className="flex flex-wrap gap-1.5">
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

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-neutral-900">Upload files</Label>
                      <span className="text-caption text-muted-foreground">(optional)</span>
                    </div>
                    <p className="text-caption text-muted-foreground">
                      To add new references, upload your files below.
                    </p>
                    <FileUpload onFiles={handleUpload} disabled={!moduleId || isReserving} />

                    {fileList.length > 0 && (
                      <div className="mt-2 flex flex-col gap-2">
                        <p className="text-caption font-semibold text-neutral-900">Uploaded files</p>
                        <ul className="flex flex-col gap-2">
                          {fileList.map((f) => {
                            const tracked = trackedFiles[f.fileId]
                            const status = tracked?.status ?? f.status
                            const failed = status === "upload_failed" || status === "failed"
                            return (
                              <li key={f.fileId} className="rounded-sm border border-border p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="flex min-w-0 items-center gap-3">
                                    <Icon
                                      icon={MdInsertDriveFile}
                                      size={20}
                                      className="shrink-0 text-muted-foreground"
                                    />
                                    <div className="flex min-w-0 flex-col">
                                      <span className="truncate text-caption font-semibold text-neutral-900">
                                        {f.fileName}
                                      </span>
                                      <span
                                        className={cn(
                                          "text-caption",
                                          failed ? "text-destructive" : "text-muted-foreground"
                                        )}
                                      >
                                        {statusLabel(status)}
                                      </span>
                                    </div>
                                  </div>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Remove ${f.fileName}`}
                                    onClick={() => removeFile(f.fileId)}
                                  >
                                    <Icon icon={MdDelete} size={18} />
                                  </Button>
                                </div>
                                {f.status === "uploading" && <Progress value={f.progress} className="mt-2" />}
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
                <div className="flex flex-col gap-8">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="module-prompt" className="text-neutral-900">Module prompt</Label>
                      <span className="text-caption text-muted-foreground">(optional)</span>
                    </div>
                    <p className="text-caption text-muted-foreground">
                      Provide any specific instructions for this module, which will be used with the
                      course-level prompt.
                    </p>
                    <Textarea
                      id="module-prompt"
                      value={modulePrompt}
                      onChange={(e) => setModulePrompt(e.target.value)}
                      rows={5}
                      placeholder="Module-specific instructions for the assistant…"
                    />
                  </div>
                  <div className="flex flex-col gap-3">
                    <Label className="text-neutral-900">Key topics</Label>
                    <p className="text-caption text-muted-foreground">
                      OCELIA automatically suggests key topics based on your uploaded files. You can
                      add/remove a topic or edit an existing one by clicking it below. To restore any
                      previously suggested topics, click the &lsquo;Suggest&rsquo; button.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={handleGenerate} loading={isGenerating}>
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
                        className="flex-1"
                      />
                    </div>
                    {keyTopics.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {keyTopics.map((t) => (
                          <Tag key={t} label={t} onRemove={() => setKeyTopics((prev) => prev.filter((x) => x !== t))} />
                        ))}
                      </div>
                    )}
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

          <div className="flex items-center justify-between gap-2 border-t border-border px-8 py-4">
            <div>
              {step > 0 && (
                <Button variant="ghost" className="text-primary" onClick={() => setStep((s) => s - 1)}>
                  Back
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCancelOpen(true)}>
                Discard
              </Button>
              {step < STEP_COUNT - 1 ? (
                <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
                  Next
                </Button>
              ) : (
                <Button onClick={handleSave} loading={finalize.isPending} disabled={!canSave}>
                  Publish
                </Button>
              )}
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
    </>
  )
}
