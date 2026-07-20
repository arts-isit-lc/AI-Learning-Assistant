import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useParams } from "react-router-dom"
import { toast } from "react-toastify"
import { MdClose } from "react-icons/md"
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
import { FileUpload } from "@/components/composed/FileUpload"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { BackButton } from "@/components/composed/BackButton"
import { Tag } from "@/components/composed/Tag"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Icon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"

/**
 * Single-page module editor (Figma Modal/EditModule) — all module fields on one
 * form (not stepped): name, concept, prompt, key topics, and files (add/remove).
 * Opened from the Configuration tree's Edit action. Route:
 * /instructor/courses/:courseId/modules/:moduleId/edit.
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
  const seededRef = useRef(false)
  const refsSeededRef = useRef(false)

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

  const fileList = Object.values(fileStates)
  const isProcessingBlocking = [...fileList, ...Object.values(trackedFiles)].some((f) =>
    BLOCKING_STATUSES.includes(f.status)
  )
  const visibleExisting = existingFiles.filter((f) => !removedFiles.has(f.fileName))
  const otherFiles = useMemo(
    () => courseFiles.filter((f) => f.module_id !== moduleId),
    [courseFiles, moduleId]
  )
  const canSave = Boolean(moduleName.trim() && conceptId) && !isProcessingBlocking && !editModule.isPending

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
          goToConfiguration()
        },
        onError: (err) => {
          if (err?.status === 400) toast.error("A module with this name already exists")
          else toast.error("Failed to update module")
        },
      }
    )
  }

  if (!moduleData) {
    return <p className="text-caption text-muted-foreground">Loading module…</p>
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <BackButton onClick={goToConfiguration}>Back to configuration</BackButton>
        <Button
          variant="danger"
          onClick={() => setDeleteOpen(true)}
          disabled={deleteModule.isPending}
        >
          Delete module
        </Button>
      </div>
      <h1 className="text-h4 font-semibold text-navy">Edit module</h1>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-module-name">Module name</Label>
            <Input
              id="edit-module-name"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              maxLength={100}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {visibleExisting.length > 0 && (
            <ul className="flex flex-col gap-2">
              {visibleExisting.map((f) => (
                <li
                  key={f.fileName}
                  className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
                >
                  <span className="truncate text-caption">{f.fileName}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${f.fileName}`}
                    onClick={() => setRemovedFiles((prev) => new Set(prev).add(f.fileName))}
                  >
                    <Icon icon={MdClose} size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <FileUpload onFiles={handleUpload} disabled={!moduleId} />
          {fileList.length > 0 && (
            <ul className="flex flex-col gap-2">
              {fileList.map((f) => (
                <li key={f.fileId} className="rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-caption font-semibold">{f.fileName}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${f.fileName}`}
                      onClick={() => removeFile(f.fileId)}
                    >
                      <Icon icon={MdClose} size={16} />
                    </Button>
                  </div>
                  {f.status === "uploading" && <Progress value={f.progress} className="mt-2" />}
                </li>
              ))}
            </ul>
          )}

          {otherFiles.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-caption font-semibold text-foreground">
                Reference files from other modules
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Prompt &amp; topics</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-module-prompt">Module prompt</Label>
            <Textarea
              id="edit-module-prompt"
              value={modulePrompt}
              onChange={(e) => setModulePrompt(e.target.value)}
              rows={6}
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
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={goToConfiguration}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={editModule.isPending} disabled={!canSave}>
          Save changes
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete module?"
        description={`Delete "${moduleData.module_name}" and its files? This can't be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleteModule.isPending}
        onConfirm={() =>
          deleteModule.mutate(moduleData, {
            onSuccess: () => {
              setDeleteOpen(false)
              toast.success("Module deleted")
              goToConfiguration()
            },
          })
        }
      />
    </div>
  )
}
