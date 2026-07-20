import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdClose } from "react-icons/md"
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
import { BLOCKING_STATUSES } from "@/constants/uploadConfig"
import { WizardStepper } from "@/components/composed/WizardStepper"
import { FileUpload } from "@/components/composed/FileUpload"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { Tag } from "@/components/composed/Tag"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

const STEPS = ["Details", "References", "Prompt & topics", "Review"]

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

/**
 * Module create wizard (4 steps: Details -> References -> Prompt & topics ->
 * Review). Reserves a draft module on mount so files upload before Save; files
 * are ingested asynchronously (polled) and Save is gated until processing
 * finishes. Finalize sets the module active, then a module-scope prompt check
 * runs (non-blocking). Route: /instructor/courses/:courseId/modules/new.
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

  const goToConfiguration = () => navigate(`/instructor/courses/${courseId}/configuration`)

  const handleCancel = async () => {
    setCancelOpen(false)
    await cleanup()
    goToConfiguration()
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
          goToConfiguration()
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
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-h4 font-semibold text-navy">Create module</h1>
      <WizardStepper steps={STEPS} current={step} />

      {reserveError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&rsquo;t start a new module</AlertTitle>
          <AlertDescription>{reserveError}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="flex flex-col gap-4 p-6">
          {step === 0 && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="module-name">Module name</Label>
                <Input
                  id="module-name"
                  value={moduleName}
                  onChange={(e) => setModuleName(e.target.value)}
                  maxLength={100}
                  placeholder="e.g. Vectors and matrices"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Concept</Label>
                <Select value={conceptId} onValueChange={setConceptId}>
                  <SelectTrigger aria-label="Concept" className="max-w-sm">
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
            </>
          )}

          {step === 1 && (
            <>
              <FileUpload onFiles={handleUpload} disabled={!moduleId || isReserving} />
              {fileList.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {fileList.map((f) => {
                    const tracked = trackedFiles[f.fileId]
                    const status = tracked?.status ?? f.status
                    return (
                      <li key={f.fileId} className="rounded-md border border-border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-caption font-semibold">{f.fileName}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-caption text-muted-foreground">{statusLabel(status)}</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Remove ${f.fileName}`}
                              onClick={() => removeFile(f.fileId)}
                            >
                              <Icon icon={MdClose} size={16} />
                            </Button>
                          </div>
                        </div>
                        {f.status === "uploading" && <Progress value={f.progress} className="mt-2" />}
                      </li>
                    )
                  })}
                </ul>
              )}

              {otherFiles.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-caption font-semibold text-foreground">
                    Reference files from other modules (optional)
                  </p>
                  <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                    {otherFiles.map((f) => (
                      <li key={f.file_id}>
                        <label className="flex items-center gap-2 text-caption">
                          <input
                            type="checkbox"
                            checked={referencedFileIds.includes(f.file_id)}
                            onChange={() =>
                              setReferencedFileIds((prev) =>
                                prev.includes(f.file_id)
                                  ? prev.filter((id) => id !== f.file_id)
                                  : [...prev, f.file_id]
                              )
                            }
                          />
                          <span className="truncate">
                            {f.filename || f.file_id}
                            {f.module_name ? ` — ${titleCase(f.module_name)}` : ""}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="module-prompt">Module prompt (optional)</Label>
                <Textarea
                  id="module-prompt"
                  value={modulePrompt}
                  onChange={(e) => setModulePrompt(e.target.value)}
                  rows={6}
                  placeholder="Module-specific instructions for the assistant…"
                />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <Label>Key topics</Label>
                  <Button size="sm" variant="outline" onClick={handleGenerate} loading={isGenerating}>
                    Generate topics
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={topicInput}
                    onChange={(e) => setTopicInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        addTopic()
                      }
                    }}
                    placeholder="Add a topic and press Enter"
                    aria-label="Add key topic"
                  />
                  <Button variant="outline" onClick={addTopic}>
                    Add
                  </Button>
                </div>
                {keyTopics.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {keyTopics.map((t) => (
                      <Tag key={t} label={t} onRemove={() => setKeyTopics((prev) => prev.filter((x) => x !== t))} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 3 && (
            <dl className="flex flex-col gap-3 text-caption">
              <div>
                <dt className="font-semibold text-foreground">Module name</dt>
                <dd className="text-muted-foreground">{moduleName || "—"}</dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Concept</dt>
                <dd className="text-muted-foreground">
                  {titleCase(concepts.find((c) => c.concept_id === conceptId)?.concept_name || "—")}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Files</dt>
                <dd className="text-muted-foreground">
                  {fileList.length} uploaded{isProcessingBlocking ? " (still processing…)" : ""}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-foreground">Key topics</dt>
                <dd className="text-muted-foreground">{keyTopics.length ? keyTopics.join(", ") : "None"}</dd>
              </div>
              {!canSave && !finalize.isPending && (
                <p className="text-caption text-muted-foreground">
                  {isProcessingBlocking
                    ? "Waiting for file processing to finish before you can create the module."
                    : "Add a name, concept, and at least one file to create the module."}
                </p>
              )}
            </dl>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => setCancelOpen(true)}>
          Cancel
        </Button>
        <div className="flex gap-2">
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
              Next
            </Button>
          ) : (
            <Button onClick={handleSave} loading={finalize.isPending} disabled={!canSave}>
              Create module
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Discard this module?"
        description="Your uploaded files and progress for this draft will be discarded."
        confirmLabel="Discard"
        variant="danger"
        onConfirm={handleCancel}
      />
    </div>
  )
}
