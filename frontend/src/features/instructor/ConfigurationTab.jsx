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
import { ModuleAccordion } from "@/components/composed/ModuleAccordion"
import { EmptyState } from "@/components/composed/EmptyState"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Icon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"

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

/** Wraps a concept in `useSortable` and hands the drag bits to ModuleAccordion. */
function SortableConceptSection({ concept, modules, number, ...handlers }) {
  const s = useSortable({ id: concept.concept_id })
  const style = { transform: CSS.Transform.toString(s.transform), transition: s.transition }
  return (
    <ModuleAccordion
      concept={concept}
      modules={modules}
      number={number}
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
  const { data: concepts = [], isLoading, isError } = useConcepts(courseId)
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

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const tree = useMemo(() => groupConceptTree(concepts, modules), [concepts, modules])
  const conceptIds = tree.map((t) => t.concept.concept_id)

  const moduleBasePath = `/instructor/courses/${courseId}/configuration/modules`

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
    reorderConcepts.mutate(arrayMove(concepts, oldIndex, newIndex))
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
    onReorderModules: (ordered) => reorderModules.mutate(ordered),
    onEditModule: (m) => navigate(`${moduleBasePath}/${m.module_id}/edit`, { state: { module: m } }),
    onDeleteModule: (m) => setDeleteModuleTarget(m),
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs leading-7 font-semibold text-neutral-900">Course configuration</h2>
        <div className="flex gap-2">
          {/* Figma `Button/UI/Desktop/Secondary with Icon` (node 1099:6534): outline
              purple, h-28 / px-8 / gap-8 / rounded-4, 20px add icon. */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-2 rounded-sm px-2"
            aria-label="Add concept"
            onClick={() => setAddingConcept(true)}
          >
            Concept <Icon icon={MdAdd} size={20} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-2 rounded-sm px-2"
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

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&rsquo;t load the course structure</AlertTitle>
          <AlertDescription>Please refresh and try again.</AlertDescription>
        </Alert>
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
            <div className="flex flex-col gap-3">
              {tree.map(({ concept, modules: conceptModules }, i) => (
                <SortableConceptSection
                  key={concept.concept_id}
                  concept={concept}
                  modules={conceptModules}
                  number={i + 1}
                  {...conceptHandlers(concept, conceptModules)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Footer (Figma 365:2622) — shown in every state, incl. empty: Student view
          (left) previews the course as a student; Save changes (right) is disabled
          because configuration edits (add/rename/delete/reorder) persist immediately. */}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <Button variant="link" className="p-0" onClick={openStudentView}>
          Student view
        </Button>
        <Button variant="ghost" className="text-neutral-300" disabled>
          Save changes
        </Button>
      </div>

      <ConfirmDialog
        open={Boolean(deleteConceptTarget)}
        onOpenChange={(open) => !open && setDeleteConceptTarget(null)}
        title="Delete concept?"
        description="This also deletes the concept's modules and their files. This can't be undone."
        confirmLabel="Delete"
        variant="danger"
        loading={deleteConcept.isPending}
        onConfirm={() =>
          deleteConcept.mutate(deleteConceptTarget, {
            onSuccess: () => setDeleteConceptTarget(null),
          })
        }
      />

      <ConfirmDialog
        open={Boolean(deleteModuleTarget)}
        onOpenChange={(open) => !open && setDeleteModuleTarget(null)}
        title="Delete module?"
        description={
          deleteModuleTarget ? `Delete "${deleteModuleTarget.module_name}" and its files? This can't be undone.` : ""
        }
        confirmLabel="Delete"
        variant="danger"
        loading={deleteModule.isPending}
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
