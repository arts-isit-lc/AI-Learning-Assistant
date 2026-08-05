import { useMemo, useState } from "react"
import { Outlet, useNavigate, useParams } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { MdAdd, MdAccountTree } from "react-icons/md"
import {
  useConcepts,
  useModules,
  useCreateConcept,
  useRenameConcept,
  useDeleteConcept,
  useDeleteModule,
  useReorderConcepts,
  useReorderModules,
} from "@/services/queries"
import { toUserMessage } from "@/services/apiError"
import { ModuleAccordion } from "@/components/composed/ModuleAccordion"
import { EmptyState } from "@/components/composed/EmptyState"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { Alert, AlertDescription } from "@/components/ui/alert"

/**
 * Group flat modules under their concept (by concept_id, falling back to
 * concept_name), each sorted by module_number. Exported for unit testing.
 */
export function groupConceptTree(concepts, modules) {
  const byConcept = new Map(concepts.map((c) => [c.concept_id, []]))
  const idByName = new Map(concepts.map((c) => [c.concept_name, c.concept_id]))
  for (const m of modules) {
    const cid = m.concept_id && byConcept.has(m.concept_id) ? m.concept_id : idByName.get(m.concept_name)
    if (cid && byConcept.has(cid)) byConcept.get(cid).push(m)
  }
  const byNumber = (a, b) => (a.module_number ?? 0) - (b.module_number ?? 0)
  return concepts.map((c) => ({ concept: c, modules: [...byConcept.get(c.concept_id)].sort(byNumber) }))
}

/**
 * Reconcile a staged id order with the current server ids: keep the staged ids
 * that still exist (in their staged order), then append any server ids not yet
 * staged (newly added). `staged == null` → just the server order. Exported for
 * unit testing. Keeps the staged reorder resilient to immediate add/delete.
 */
export function reconcileOrder(serverIds, staged) {
  if (!staged) return serverIds
  const present = new Set(serverIds)
  const kept = staged.filter((id) => present.has(id))
  const keptSet = new Set(kept)
  return [...kept, ...serverIds.filter((id) => !keptSet.has(id))]
}

/** Ordered equality for two id lists. */
function sameOrder(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Wraps a concept in `useSortable` and hands the drag bits to ModuleAccordion. */
function SortableConceptSection({ concept, modules, number, courseId, ...handlers }) {
  const s = useSortable({ id: concept.concept_id })
  const style = { transform: CSS.Transform.toString(s.transform), transition: s.transition }
  return (
    <ModuleAccordion
      concept={concept}
      modules={modules}
      number={number}
      courseId={courseId}
      sortable={{
        setNodeRef: s.setNodeRef,
        style,
        attributes: s.attributes,
        listeners: s.listeners,
        isDragging: s.isDragging,
      }}
      {...handlers}
    />
  )
}

/**
 * Configuration tab — the Concept -> Module tree. Concepts and their modules are
 * drag-and-drop reorderable (@dnd-kit); concepts support inline rename, add, and
 * delete (cascading to their modules). Expanding a module shows a read-only
 * summary with Edit (-> single-page editor) and Delete.
 */
export function ConfigurationTab() {
  const { courseId } = useParams()
  const navigate = useNavigate()
  const { setIsInstructorAsStudent } = useAuth()
  const { data: concepts = [], isLoading, isError, error, refetch } = useConcepts(courseId)
  const { data: modules = [] } = useModules(courseId)

  const createConcept = useCreateConcept(courseId)
  const renameConcept = useRenameConcept(courseId)
  const deleteConcept = useDeleteConcept(courseId)
  const deleteModule = useDeleteModule(courseId)
  const reorderConcepts = useReorderConcepts(courseId)
  const reorderModules = useReorderModules(courseId)

  const [addingConcept, setAddingConcept] = useState(false)
  const [newConceptName, setNewConceptName] = useState("")
  const [deleteConceptTarget, setDeleteConceptTarget] = useState(null)
  const [deleteModuleTarget, setDeleteModuleTarget] = useState(null)

  // Staged reorder — concept/module drags update these local ORDER overrides (id
  // lists; null/absent = follow the server order) and are NOT persisted until the
  // user clicks "Save changes". Objects always resolve fresh from the server
  // cache, so renames/edits + immediate add/delete flow through while only the
  // ORDER is staged locally.
  const [conceptOrder, setConceptOrder] = useState(null)
  const [moduleOrders, setModuleOrders] = useState({})
  const [savingOrder, setSavingOrder] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const serverTree = useMemo(() => groupConceptTree(concepts, modules), [concepts, modules])

  // Display tree = the server order overlaid with the staged drag reorders, plus
  // the dirty flags derived from comparing the two.
  const { tree, isDirty, conceptsReordered, reorderedModuleConceptIds } = useMemo(() => {
    const conceptsById = new Map(concepts.map((c) => [c.concept_id, c]))
    const modulesById = new Map(modules.map((m) => [m.module_id, m]))
    const serverConceptIds = serverTree.map((t) => t.concept.concept_id)
    const serverModuleIds = new Map(
      serverTree.map((t) => [t.concept.concept_id, t.modules.map((m) => m.module_id)])
    )
    const modIdsFor = (cid) => reconcileOrder(serverModuleIds.get(cid) ?? [], moduleOrders[cid])
    const displayConceptIds = reconcileOrder(serverConceptIds, conceptOrder)

    const nextTree = displayConceptIds
      .map((cid) => {
        const concept = conceptsById.get(cid)
        if (!concept) return null
        return { concept, modules: modIdsFor(cid).map((id) => modulesById.get(id)).filter(Boolean) }
      })
      .filter(Boolean)

    const reorderedMods = displayConceptIds.filter(
      (cid) => !sameOrder(modIdsFor(cid), serverModuleIds.get(cid) ?? [])
    )
    const conceptsMoved = !sameOrder(displayConceptIds, serverConceptIds)
    return {
      tree: nextTree,
      conceptsReordered: conceptsMoved,
      reorderedModuleConceptIds: reorderedMods,
      isDirty: conceptsMoved || reorderedMods.length > 0,
    }
  }, [concepts, modules, serverTree, conceptOrder, moduleOrders])

  const conceptIds = tree.map((t) => t.concept.concept_id)

  const moduleBasePath = `/instructor/courses/${courseId}/configuration/modules`

  // Drag → stage a concept's module order (ids only); persisted on Save.
  const stageModuleOrder = (conceptId, ordered) =>
    setModuleOrders((prev) => ({ ...prev, [conceptId]: ordered.map((m) => m.module_id) }))

  // Persist all staged reorders (concepts + each changed concept's modules). On
  // failure each mutation rolls back its own cache and surfaces the inline error
  // below; we keep the staged order so the user can retry Save.
  const saveOrder = async () => {
    setSavingOrder(true)
    try {
      if (conceptsReordered) await reorderConcepts.mutateAsync(tree.map((t) => t.concept))
      for (const cid of reorderedModuleConceptIds) {
        const node = tree.find((t) => t.concept.concept_id === cid)
        if (node) await reorderModules.mutateAsync(node.modules)
      }
      setConceptOrder(null)
      setModuleOrders({})
    } catch {
      // Surfaced via the mutations' isError (inline Alert below); staged order kept.
    } finally {
      setSavingOrder(false)
    }
  }

  // Preview this course as a student. Instructors are permitted on the student
  // route (see AppRoutes); the flag mirrors the header's "View as student" and
  // keeps progress writes off while previewing.
  const openStudentView = () => {
    setIsInstructorAsStudent(true)
    navigate(`/courses/${courseId}`)
  }

  const handleConceptDragEnd = (event) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = conceptIds.indexOf(active.id)
    const newIndex = conceptIds.indexOf(over.id)
    if (oldIndex < 0 || newIndex < 0) return
    // Stage the new concept order (ids); persisted on Save.
    setConceptOrder(arrayMove(conceptIds, oldIndex, newIndex))
  }

  const submitNewConcept = () => {
    const name = newConceptName.trim()
    if (!name) return
    createConcept.mutate(
      { conceptName: name, nextNumber: concepts.length + 1 },
      {
        onSuccess: () => {
          setNewConceptName("")
          setAddingConcept(false)
        },
      }
    )
  }

  const conceptHandlers = (concept, conceptModules) => ({
    onRename: (name) =>
      renameConcept.mutate({
        conceptId: concept.concept_id,
        conceptName: name,
        conceptNumber: concept.concept_number,
      }),
    onDelete: () => setDeleteConceptTarget({ concept, modules: conceptModules }),
    onAddModule: () => navigate(`${moduleBasePath}/new?concept=${concept.concept_id}`),
    onReorderModules: (ordered) => stageModuleOrder(concept.concept_id, ordered),
    onEditModule: (m) => navigate(`${moduleBasePath}/${m.module_id}/edit`, { state: { module: m } }),
    onDeleteModule: (m) => setDeleteModuleTarget(m),
  })

  return (
    <div className="flex flex-col gap-4">
      {/* Guard the staged reorder against navigation (tab switch / back / refresh). */}
      <UnsavedChangesPrompt when={isDirty} />
      <div className="flex items-center justify-between gap-2 mb-8">
        <h2 className="text-sm leading-7 font-semibold text-neutral-900">Course configuration</h2>
        <div className="flex gap-2">
          {/* Figma `Button/UI/Desktop/Secondary with Icon` (node 1099:6534): outline
              purple, px-8 / gap-8 / rounded-4, 20px add icon. Height is a fixed 30px
              via h-[30px]; box-sizing is border-box, so this INCLUDES the 1px border
              (28px content area). An explicit height is required — padding can't grow
              a fixed-height border-box, which is why adding py-* did nothing. */}
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] gap-2 rounded-sm px-2"
            aria-label="Add concept"
            onClick={() => setAddingConcept(true)}
          >
            Concept <Icon icon={MdAdd} size={20} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-[30px] gap-2 rounded-sm px-2"
            aria-label="Add module"
            onClick={() => navigate(`${moduleBasePath}/new`)}
            disabled={concepts.length === 0}
          >
            Module <Icon icon={MdAdd} size={20} />
          </Button>
        </div>
      </div>

      {addingConcept && (
        <div className="flex items-center gap-2">
          <Input
            value={newConceptName}
            onChange={(e) => setNewConceptName(e.target.value)}
            placeholder="Concept name"
            aria-label="New concept name"
            maxLength={50}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewConcept()
              if (e.key === "Escape") {
                setAddingConcept(false)
                setNewConceptName("")
              }
            }}
          />
          <Button onClick={submitNewConcept} loading={createConcept.isPending}>
            Add
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setAddingConcept(false)
              setNewConceptName("")
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {(reorderConcepts.isError || reorderModules.isError) && (
        <Alert variant="destructive">
          <AlertDescription>{"Couldn't save your changes. Please try again."}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Couldn't load the course structure"
          description={toUserMessage(error)}
          onRetry={() => refetch()}
        />
      ) : concepts.length === 0 ? (
        // Figma 1099:6510: a filled muted panel with just the icon + copy — no
        // in-panel action button (the header "Concept" button is the add path).
        <EmptyState
          icon={MdAccountTree}
          title="No concepts yet"
          description="Add a concept to start organizing this course's modules."
          className="border-0 bg-muted"
        />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleConceptDragEnd}>
          <SortableContext items={conceptIds} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-6 mb-6">
              {tree.map(({ concept, modules: conceptModules }, i) => (
                <SortableConceptSection
                  key={concept.concept_id}
                  concept={concept}
                  modules={conceptModules}
                  number={i + 1}
                  courseId={courseId}
                  {...conceptHandlers(concept, conceptModules)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Footer (Figma 365:2622) — Student view (left) previews the course as a
          student; Save changes (right) persists a STAGED concept/module reorder.
          Add/rename/delete still persist immediately, so Save is only active while
          there's an unsaved reorder. */}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Button variant="link" className="p-0" onClick={openStudentView}>
          Student view
        </Button>
        <Button
          variant="ghost"
          className={isDirty ? "text-primary" : "text-neutral-300"}
          onClick={saveOrder}
          disabled={!isDirty || savingOrder}
          loading={savingOrder}
        >
          Save changes
        </Button>
      </div>

      <ConfirmDialog
        open={Boolean(deleteConceptTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConceptTarget(null)
            deleteConcept.reset?.()
          }
        }}
        title="Delete concept?"
        description="This also deletes the concept's modules and their files. This can't be undone."
        confirmLabel="Delete"
        loading={deleteConcept.isPending}
        error={deleteConcept.isError ? toUserMessage(deleteConcept.error) : undefined}
        onConfirm={() =>
          deleteConcept.mutate(deleteConceptTarget, {
            onSuccess: () => setDeleteConceptTarget(null),
          })
        }
      />

      <ConfirmDialog
        open={Boolean(deleteModuleTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteModuleTarget(null)
            deleteModule.reset?.()
          }
        }}
        title="Delete module?"
        description={
          deleteModuleTarget ? `Delete "${deleteModuleTarget.module_name}" and its files? This can't be undone.` : ""
        }
        confirmLabel="Delete"
        loading={deleteModule.isPending}
        error={deleteModule.isError ? toUserMessage(deleteModule.error) : undefined}
        onConfirm={() =>
          deleteModule.mutate(deleteModuleTarget, {
            onSuccess: () => setDeleteModuleTarget(null),
          })
        }
      />

      {/* Create / Edit module render as centered modals over this tab (nested route). */}
      <Outlet />
    </div>
  )
}
