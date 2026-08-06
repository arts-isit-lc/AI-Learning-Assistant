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
import { UnsavedChangesPrompt } from "@/components/composed/UnsavedChangesPrompt"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorState } from "@/components/composed/ErrorState"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

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
  const {
    data: concepts = [],
    isLoading: conceptsLoading,
    isError: conceptsError,
    error: conceptsErrorObj,
    refetch: refetchConcepts,
  } = useConcepts(courseId)
  const {
    data: modules = [],
    isLoading: modulesLoading,
    isError: modulesError,
    error: modulesErrorObj,
    refetch: refetchModules,
  } = useModules(courseId)

  // The tree needs BOTH concepts and their modules (separate queries). Gate the
  // skeleton on both so the whole structure renders at once — otherwise concepts
  // render first and their modules pop in a beat later (worse on revisits, where
  // one query is cached and the other isn't). Same for errors + retry.
  const isLoading = conceptsLoading || modulesLoading
  const isError = conceptsError || modulesError
  const error = conceptsErrorObj || modulesErrorObj
  const refetch = () => {
    refetchConcepts?.()
    refetchModules?.()
  }

  const createConcept = useCreateConcept(courseId)
  const renameConcept = useRenameConcept(courseId)
  const deleteConcept = useDeleteConcept(courseId)
  const deleteModule = useDeleteModule(courseId)
  const reorderConcepts = useReorderConcepts(courseId)
  const reorderModules = useReorderModules(courseId)

  const [addingConcept, setAddingConcept] = useState(false)
  const [newConceptName, setNewConceptName] = useState("")

  // Staged edits — concept/module drag reorders (id lists; null/absent = follow
  // the server order), concept renames ({ [conceptId]: newName }), AND concept/
  // module deletions (id Sets) are held locally and NOT persisted until "Save
  // changes" (revert them with Undo). Only ADD still persists immediately (the
  // server generates the id, and the new row is usually acted on right away).
  const [conceptOrder, setConceptOrder] = useState(null)
  const [moduleOrders, setModuleOrders] = useState({})
  const [conceptNames, setConceptNames] = useState({})
  const [deletedConceptIds, setDeletedConceptIds] = useState(() => new Set())
  const [deletedModuleIds, setDeletedModuleIds] = useState(() => new Set())
  const [saving, setSaving] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const serverTree = useMemo(() => groupConceptTree(concepts, modules), [concepts, modules])

  // Display tree = the server order overlaid with the staged reorders, renames,
  // and deletions, plus the dirty flags derived from comparing the two.
  const {
    tree,
    isDirty,
    conceptsReordered,
    reorderedModuleConceptIds,
    renamedConceptIds,
    stagedConceptDeletes,
    stagedModuleDeletes,
  } = useMemo(() => {
    const conceptsById = new Map(concepts.map((c) => [c.concept_id, c]))
    const modulesById = new Map(modules.map((m) => [m.module_id, m]))

    // module_id -> owning concept_id per the server grouping (respects the
    // concept_name fallback groupConceptTree applies), so a module under a
    // staged-deleted concept is recognised even when its concept_id is absent.
    const conceptIdByModuleId = new Map()
    for (const t of serverTree) {
      for (const m of t.modules) conceptIdByModuleId.set(m.module_id, t.concept.concept_id)
    }

    // Only count staged deletions whose target STILL exists server-side, so a
    // completed (or partially-applied) delete doesn't linger as "dirty" or get
    // retried after the row is already gone.
    const deletedConceptSet = new Set([...deletedConceptIds].filter((id) => conceptsById.has(id)))
    const delConceptIds = [...deletedConceptSet]
    // Individually-staged module deletes, minus any already covered by a staged
    // concept delete (that concept's cascade removes its modules for us).
    const delModuleIds = [...deletedModuleIds].filter(
      (id) => modulesById.has(id) && !deletedConceptSet.has(conceptIdByModuleId.get(id))
    )

    // Surviving server order (staged-deleted ids removed) — the baseline we diff
    // the staged reorder against, so a pure delete isn't misread as a reorder.
    const survivingConceptIds = serverTree
      .map((t) => t.concept.concept_id)
      .filter((cid) => !deletedConceptSet.has(cid))
    const survivingModuleIds = new Map(
      serverTree.map((t) => [
        t.concept.concept_id,
        t.modules.filter((m) => !deletedModuleIds.has(m.module_id)).map((m) => m.module_id),
      ])
    )
    const modIdsFor = (cid) => reconcileOrder(survivingModuleIds.get(cid) ?? [], moduleOrders[cid])
    const displayConceptIds = reconcileOrder(survivingConceptIds, conceptOrder)

    // Overlay a staged rename (that still differs from the server name) onto the
    // concept so both the tree AND the reorder save payload — which carries
    // concept_name — reflect the new name.
    const nextTree = displayConceptIds
      .map((cid) => {
        const concept = conceptsById.get(cid)
        if (!concept) return null
        const staged = conceptNames[cid]
        const displayConcept =
          staged != null && staged !== concept.concept_name ? { ...concept, concept_name: staged } : concept
        return {
          concept: displayConcept,
          modules: modIdsFor(cid).map((id) => modulesById.get(id)).filter(Boolean),
        }
      })
      .filter(Boolean)

    const renamedIds = displayConceptIds.filter((cid) => {
      const staged = conceptNames[cid]
      const server = conceptsById.get(cid)
      return staged != null && server && staged !== server.concept_name
    })
    const reorderedMods = displayConceptIds.filter(
      (cid) => !sameOrder(modIdsFor(cid), survivingModuleIds.get(cid) ?? [])
    )
    const conceptsMoved = !sameOrder(displayConceptIds, survivingConceptIds)
    const hasDeletions = delConceptIds.length > 0 || delModuleIds.length > 0
    return {
      tree: nextTree,
      conceptsReordered: conceptsMoved,
      reorderedModuleConceptIds: reorderedMods,
      renamedConceptIds: renamedIds,
      stagedConceptDeletes: delConceptIds,
      stagedModuleDeletes: delModuleIds,
      isDirty: hasDeletions || conceptsMoved || reorderedMods.length > 0 || renamedIds.length > 0,
    }
  }, [concepts, modules, serverTree, conceptOrder, moduleOrders, conceptNames, deletedConceptIds, deletedModuleIds])

  const conceptIds = tree.map((t) => t.concept.concept_id)

  const moduleBasePath = `/instructor/courses/${courseId}/configuration/modules`

  // Drag → stage a concept's module order (ids only); persisted on Save.
  const stageModuleOrder = (conceptId, ordered) =>
    setModuleOrders((prev) => ({ ...prev, [conceptId]: ordered.map((m) => m.module_id) }))

  // Discard every staged edit — reorder + renames + deletions — back to the
  // last-saved (server) state. Powers the Undo button and the post-save reset.
  const discardChanges = () => {
    setConceptOrder(null)
    setModuleOrders({})
    setConceptNames({})
    setDeletedConceptIds(new Set())
    setDeletedModuleIds(new Set())
  }

  // Persist all staged edits. Order matters: deletions first (so any renumbering
  // operates on the survivors), then concept renames (each keeps its number),
  // then the concept reorder, then each changed concept's module order. The
  // reorder payload also carries concept_name, so a renamed+reordered concept
  // stays consistent regardless of order. Deleting a concept cascades to its
  // modules (S3 + rows), so modules under a staged-deleted concept are already
  // excluded from stagedModuleDeletes. On failure each mutation rolls back its
  // own cache and surfaces the inline error below; the staged edits are kept so
  // the user can retry.
  const saveChanges = async () => {
    setSaving(true)
    try {
      const conceptsById = new Map(concepts.map((c) => [c.concept_id, c]))
      const modulesById = new Map(modules.map((m) => [m.module_id, m]))
      const modulesByConceptId = new Map(serverTree.map((t) => [t.concept.concept_id, t.modules]))

      for (const cid of stagedConceptDeletes) {
        const concept = conceptsById.get(cid)
        // Pass the concept's server modules so the cascade cleans up their S3 objects.
        if (concept)
          await deleteConcept.mutateAsync({ concept, modules: modulesByConceptId.get(cid) ?? [] })
      }
      for (const mid of stagedModuleDeletes) {
        const mod = modulesById.get(mid)
        if (mod) await deleteModule.mutateAsync(mod)
      }
      for (const cid of renamedConceptIds) {
        const node = tree.find((t) => t.concept.concept_id === cid)
        if (node)
          await renameConcept.mutateAsync({
            conceptId: cid,
            conceptName: node.concept.concept_name,
            conceptNumber: node.concept.concept_number,
          })
      }
      if (conceptsReordered) await reorderConcepts.mutateAsync(tree.map((t) => t.concept))
      for (const cid of reorderedModuleConceptIds) {
        const node = tree.find((t) => t.concept.concept_id === cid)
        if (node) await reorderModules.mutateAsync(node.modules)
      }
      discardChanges()
    } catch {
      // Surfaced via the mutations' isError (inline Alert below); staged edits kept.
    } finally {
      setSaving(false)
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

  const conceptHandlers = (concept) => ({
    // Stage the rename locally (revert with Undo, persist on Save) rather than
    // writing through immediately. Dirtiness is derived by diffing against the
    // server name in the display memo, so a rename back to the original clears.
    onRename: (name) => setConceptNames((prev) => ({ ...prev, [concept.concept_id]: name })),
    // Stage the deletion (revert with Undo, persist on Save) — the concept and
    // its modules drop out of the display tree via the memo above.
    onDelete: () => setDeletedConceptIds((prev) => new Set(prev).add(concept.concept_id)),
    onAddModule: () => navigate(`${moduleBasePath}/new?concept=${concept.concept_id}`),
    onReorderModules: (ordered) => stageModuleOrder(concept.concept_id, ordered),
    onEditModule: (m) => navigate(`${moduleBasePath}/${m.module_id}/edit`, { state: { module: m } }),
    // Stage the module deletion (revert with Undo, persist on Save).
    onDeleteModule: (m) => setDeletedModuleIds((prev) => new Set(prev).add(m.module_id)),
  })

  return (
    <div className="flex flex-col gap-4">
      {/* Guard staged edits (reorder + renames + deletions) against navigation (tab switch / back / refresh). */}
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

      {(deleteConcept.isError ||
        deleteModule.isError ||
        renameConcept.isError ||
        reorderConcepts.isError ||
        reorderModules.isError) && (
        <Alert variant="destructive">
          <AlertDescription>{"Couldn't save your changes. Please try again."}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading course structure">
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
                  {...conceptHandlers(concept)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Footer (Figma 365:2622) — Student view (left) previews the course as a
          student; Undo + Save changes (right) revert or persist the STAGED
          concept/module reorder + concept renames + concept/module deletions
          together. Only ADD persists immediately, so the pair is active whenever
          there's an unsaved reorder, rename, or deletion. */}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-6">
        <Button variant="link" className="p-0" onClick={openStudentView}>
          Student view
        </Button>
        {/* Undo + Save — matched to the admin CourseDetail/InstructorDetail panes:
            28px tall (h-7 + size-sm), 4px radius (rounded), lavender (#F2E8FF /
            primary-subtle) hover, #BFBFBF (neutral-400) inactive text on a white
            (#FFF / bg-background) fill (disabled:opacity-100 defeats the base
            fade). Once active (dirty) the text turns #6829C2
            (primary) and the buttons take on the ghost-primary interaction: hover
            darkens the text to #2E0666 (primary-dark) on the lavender surface, and
            the press deepens the surface to #AA78F0 (primary-active) with the same
            #2E0666 text. Save also gains a #6829C2 border (transparent while
            disabled → no layout shift), Undo stays borderless. */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark disabled:opacity-100",
              isDirty ? "text-primary" : "bg-background text-neutral-400"
            )}
            onClick={discardChanges}
            disabled={!isDirty || saving}
          >
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 rounded border hover:bg-primary-subtle hover:text-primary-dark active:bg-primary-active active:text-primary-dark disabled:opacity-100",
              isDirty ? "border-primary text-primary" : "border-transparent bg-background text-neutral-400"
            )}
            onClick={saveChanges}
            disabled={!isDirty || saving}
            loading={saving}
          >
            Save changes
          </Button>
        </div>
      </div>

      {/* Create / Edit module render as centered modals over this tab (nested route). */}
      <Outlet />
    </div>
  )
}
