import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdDelete, MdInsertDriveFile } from "react-icons/md"
import {
  useConcepts,
  useModules,
  useCourseFiles,
  useModuleReferences,
  useModuleAllFiles,
  useEditModule,
  useDeleteModule,
  useValidatePrompt,
} from "@/services/queries"
import { useFileUpload } from "./hooks/useFileUpload"
import { useProcessingPoller } from "./hooks/useProcessingPoller"
import { useModuleTopics } from "./hooks/useModuleTopics"
import { mergeTopics } from "@/utils/topicGenerationHelpers"
import { titleCase } from "@/utils/formatters"
import { BLOCKING_STATUSES } from "@/constants/uploadConfig"
import { parseKeyTopics } from "@/components/composed/ModuleAccordion"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Tag } from "@/components/composed/Tag"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

/**
 * Single-page module editor — Figma `Modal/EditModule` (859:7574). A centered
 * modal (not stepped) rendered over the Configuration tab with ALL module fields
 * on one form: name, concept, reference, files (add/remove), prompt, key topics.
 * Opened from the Configuration tree's Edit action. Route:
 * /instructor/courses/:courseId/configuration/modules/:moduleId/edit.
 */
export function EditModule() {
  const { courseId, moduleId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()

  const { data: modules = [] } = useModules(courseId)
  const moduleData = location.state?.module || modules.find((m) => m.module_id === moduleId)

  const { data: concepts = [] } = useConcepts(courseId)
  const { data: courseFiles = [] } = useCourseFiles(courseId)
  const { data: references } = useModuleReferences(moduleId)

  const [moduleName, setModuleName] = useState(moduleData?.module_name || "")
  const [conceptId, setConceptId] = useState(moduleData?.concept_id || "")
  const [modulePrompt, setModulePrompt] = useState(moduleData?.module_prompt || "")
  const [keyTopics, setKeyTopics] = useState(() => parseKeyTopics(moduleData?.key_topics))
  const [topicInput, setTopicInput] = useState("")
  const [removedFiles, setRemovedFiles] = useState(() => new Set())
  const [referencedFileIds, setReferencedFileIds] = useState([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const seededRef = useRef(false)
  const refsSeededRef = useRef(false)
  const uploadInputRef = useRef(null)

  const { data: existingFiles = [] } = useModuleAllFiles(courseId, moduleId, moduleName)
  const { fileStates, uploadFiles, removeFile } = useFileUpload({ courseId, moduleId, moduleName })
  const { trackedFiles, addTrackedFiles } = useProcessingPoller({ moduleId, enabled: Boolean(moduleId) })
  const { generate: generateTopics, isGenerating } = useModuleTopics(moduleId)
  const editModule = useEditModule(courseId)
  const deleteModule = useDeleteModule(courseId)
  const validate = useValidatePrompt(courseId)

  // Seed form fields once the module record is available.
  useEffect(() => {
    if (moduleData && !seededRef.current) {
      seededRef.current = true
      setModuleName(moduleData.module_name || "")
      setModulePrompt(moduleData.module_prompt || "")
      setKeyTopics(parseKeyTopics(moduleData.key_topics))
      if (moduleData.concept_id) setConceptId(moduleData.concept_id)
    }
  }, [moduleData])

  // Backfill concept by name when the id isn't on the record.
  useEffect(() => {
    if (!conceptId && moduleData?.concept_name && concepts.length) {
      const found = concepts.find((c) => c.concept_name === moduleData.concept_name)
      if (found) setConceptId(found.concept_id)
    }
  }, [concepts, moduleData, conceptId])

  // Seed references once loaded.
  useEffect(() => {
    if (Array.isArray(references) && !refsSeededRef.current) {
      refsSeededRef.current = true
      setReferencedFileIds(references)
    }
  }, [references])

  // Leave the modal after a successful save/delete. Navigating from an effect
  // (rather than inline in onSuccess) lets the unsaved-changes guard observe
  // `when=false` first, so a just-saved/just-deleted module doesn't prompt.
  useEffect(() => {
    if (leaving) navigate(`/instructor/courses/${courseId}/configuration`)
  }, [leaving, navigate, courseId])

  const fileList = Object.values(fileStates)
  const isProcessingBlocking = [...fileList, ...Object.values(trackedFiles)].some((f) =>
    BLOCKING_STATUSES.includes(f.status)
  )
  const visibleExisting = existingFiles.filter((f) => !removedFiles.has(f.fileName))
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
  const canSave = Boolean(moduleName.trim() && conceptId) && !isProcessingBlocking && !editModule.isPending

  // Effective initial concept id — backfilled from concept_name when the record
  // carries no id (mirrors the backfill effect above), so re-selecting the
  // module's existing concept doesn't read as an edit.
  const initialConceptId =
    moduleData?.concept_id ||
    concepts.find((c) => c.concept_name === moduleData?.concept_name)?.concept_id ||
    ""
  const initialTopics = useMemo(() => parseKeyTopics(moduleData?.key_topics), [moduleData])
  // Unsaved staged edits (the Save button commits these). Uploaded files persist
  // immediately, so they aren't part of "unsaved"; a staged file removal is.
  const isDirty =
    Boolean(moduleData) &&
    (moduleName !== (moduleData.module_name || "") ||
      conceptId !== initialConceptId ||
      modulePrompt !== (moduleData.module_prompt || "") ||
      removedFiles.size > 0 ||
      JSON.stringify(keyTopics) !== JSON.stringify(initialTopics) ||
      (refsSeededRef.current &&
        JSON.stringify(referencedFileIds) !==
          JSON.stringify(Array.isArray(references) ? references : [])))

  const goToConfiguration = () => navigate(`/instructor/courses/${courseId}/configuration`)

  const handleUpload = async (files) => {
    const results = await uploadFiles(files)
    const uploaded = results
      .filter((r) => r?.fileId)
      .map((r) => ({ fileId: r.fileId, uploadCompletedAt: Date.now() }))
    if (uploaded.length) addTrackedFiles(uploaded)
  }

  const handleGenerate = async () => {
    try {
      const result = await generateTopics()
      if (result?.status === "processing") {
        toast.info(`Topics still processing (${result.ready}/${result.total} files).`)
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

  const handleSave = () => {
    editModule.mutate(
      {
        moduleId,
        conceptId,
        moduleName: moduleName.trim(),
        modulePrompt,
        keyTopics,
        referencedFileIds,
        removedFiles: [...removedFiles],
      },
      {
        onSuccess: async () => {
          if (modulePrompt.trim()) {
            try {
              const report = await validate.mutateAsync({ prompt: modulePrompt, scope: "module", moduleId })
              if (report?.has_conflicts) {
                toast.info("Module saved. Prompt conflicts were detected — review them in Settings.")
              }
            } catch {
              // non-blocking
            }
          }
          toast.success("Module updated")
          setLeaving(true)
        },
        onError: (err) => {
          if (err?.status === 400) toast.error("A module with this name already exists")
          else toast.error("Failed to update module")
        },
      }
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && goToConfiguration()}>
      <DialogContent className="flex max-h-[90vh] w-[min(92vw,64rem)] max-w-none flex-col gap-0 p-0">
        <UnsavedChangesPrompt when={isDirty && !leaving} />
        <div className="border-b border-border px-8 pb-4 pt-6">
          <DialogTitle className="text-h4 font-semibold text-neutral-900">Edit module</DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-8">
          <div className="mx-auto flex max-w-xl flex-col gap-6">
            <p className="text-caption text-muted-foreground">
              Changes made below are not updated unless Save is pressed once finished.
            </p>

            {!moduleData ? (
              <p className="text-caption text-muted-foreground">Loading module…</p>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="edit-module-name" className="text-neutral-900">Module name</Label>
                  <Input
                    id="edit-module-name"
                    value={moduleName}
                    onChange={(e) => setModuleName(e.target.value)}
                    maxLength={100}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label className="text-neutral-900">Concept</Label>
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

                <div className="flex flex-col gap-2">
                  <Label className="text-neutral-900">Reference</Label>
                  <Select
                    value=""
                    onValueChange={toggleReference}
                    disabled={attachableFiles.length === 0}
                  >
                    <SelectTrigger aria-label="Reference">
                      <SelectValue
                        placeholder={
                          attachableFiles.length === 0 ? "No other files available" : "Attach a reference file"
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
                        <Tag key={id} label={fileNameById.get(id) || id} onRemove={() => toggleReference(id)} />
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-neutral-900">Uploaded files</Label>
                    <button
                      type="button"
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={!moduleId}
                      className="text-caption font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      Upload files
                    </button>
                    <input
                      ref={uploadInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        handleUpload(Array.from(e.target.files || []))
                        e.target.value = ""
                      }}
                    />
                  </div>

                  <ul className="flex flex-col gap-2">
                    {visibleExisting.map((f) => (
                      <li key={f.fileName} className="rounded-sm border border-border p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Icon icon={MdInsertDriveFile} size={20} className="shrink-0 text-muted-foreground" />
                            <span className="truncate text-caption font-semibold text-neutral-900">
                              {f.fileName}
                            </span>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${f.fileName}`}
                            onClick={() => setRemovedFiles((prev) => new Set(prev).add(f.fileName))}
                          >
                            <Icon icon={MdDelete} size={18} />
                          </Button>
                        </div>
                      </li>
                    ))}
                    {fileList.map((f) => (
                      <li key={f.fileId} className="rounded-sm border border-border p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            <Icon icon={MdInsertDriveFile} size={20} className="shrink-0 text-muted-foreground" />
                            <span className="truncate text-caption font-semibold text-neutral-900">
                              {f.fileName}
                            </span>
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
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="edit-module-prompt" className="text-neutral-900">Module prompt</Label>
                  <Textarea
                    id="edit-module-prompt"
                    value={modulePrompt}
                    onChange={(e) => setModulePrompt(e.target.value)}
                    rows={5}
                  />
                </div>

                <div className="flex flex-col gap-3">
                  <Label className="text-neutral-900">Key topics</Label>
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
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-8 py-4">
          <Button variant="danger" onClick={() => setDeleteOpen(true)} disabled={deleteModule.isPending}>
            Delete module
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={goToConfiguration}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={editModule.isPending} disabled={!canSave}>
              Save changes
            </Button>
          </div>
        </div>
      </DialogContent>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete module?"
        description={moduleData ? `Delete "${moduleData.module_name}" and its files? This can't be undone.` : ""}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteModule.isPending}
        onConfirm={() =>
          deleteModule.mutate(moduleData, {
            onSuccess: () => {
              setDeleteOpen(false)
              toast.success("Module deleted")
              setLeaving(true)
            },
          })
        }
      />
    </Dialog>
  )
}
