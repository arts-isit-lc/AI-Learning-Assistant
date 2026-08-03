import { useState } from "react"
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
import * as AccordionPrimitive from "@radix-ui/react-accordion"
import { MdDragIndicator, MdEdit, MdDelete, MdCheck, MdClose, MdExpandMore } from "react-icons/md"
import { cn } from "@/lib/utils"
import { titleCase, toRoman } from "@/utils/formatters"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCourseFiles, useModuleReferences, useModuleAllFiles } from "@/services/queries"

/** key_topics may arrive as a JSON string or an array (legacy). */
export function parseKeyTopics(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** A label-over-value summary row in the expanded module panel (Figma 859:7479). */
function SummaryRow({ label, children }) {
  return (
    <div className="flex flex-col">
      <p className="font-semibold text-foreground">{label}</p>
      <p className="text-foreground">{children}</p>
    </div>
  )
}

/**
 * One module: an indented, sortable box (Figma 365:2504) showing `i. Name` + a
 * disclosure chevron, expanding to the read-only module summary (Figma 859:7479):
 * name, concept, reference, uploaded files, prompt, and key topics over a
 * Delete/Edit footer. The drag handle is always visible so the row's
 * reorderability is discoverable at rest. `number` is the module's 1-based
 * position (rendered as a roman numeral); `conceptName` labels the Concept field.
 */
function SortableModuleRow({ module, number, courseId, conceptName, onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: module.module_id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const topics = parseKeyTopics(module.key_topics)

  // Reference + uploaded files aren't part of the Configuration tree data, so
  // fetch them lazily — only once the row is expanded (passing `undefined` while
  // collapsed disables the queries). TanStack Query caches, so re-opening is
  // instant and collapsed rows fetch nothing.
  const { data: courseFiles = [] } = useCourseFiles(open ? courseId : undefined)
  const referencesQuery = useModuleReferences(open ? module.module_id : undefined)
  const filesQuery = useModuleAllFiles(
    open ? courseId : undefined,
    open ? module.module_id : undefined,
    open ? module.module_name : undefined
  )
  const referenceIds = referencesQuery.data ?? []
  const uploadedFiles = filesQuery.data ?? []
  const fileNameById = new Map(courseFiles.map((f) => [f.file_id, f.filename || f.file_id]))
  const referenceValue = referencesQuery.isLoading
    ? "Loading…"
    : referenceIds.length
      ? referenceIds.map((id) => fileNameById.get(id) || id).join(", ")
      : "None"

  return (
    <div ref={setNodeRef} style={style} className="group/module w-full max-w-[600px] rounded-sm border border-border bg-muted">
      {/* Expand/collapse via the shared Radix Accordion primitive so the slide +
          fade matches every other accordion (animate-accordion-down/up). Controlled
          so `open` also gates the lazy reference/file fetches above. */}
      <AccordionPrimitive.Root
        type="single"
        collapsible
        value={open ? "module" : ""}
        onValueChange={(v) => setOpen(v === "module")}
      >
        <AccordionPrimitive.Item value="module" className="border-0">
          <div className="flex items-center gap-2 py-1 px-2">
            <button
              type="button"
              aria-label={`Reorder ${module.module_name}`}
              className="cursor-grab touch-none rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              {...attributes}
              {...listeners}
            >
              <Icon icon={MdDragIndicator} size={24} />
            </button>
            <AccordionPrimitive.Header className="flex flex-1">
              <AccordionPrimitive.Trigger className="group flex flex-1 items-center justify-between gap-2 rounded text-left text-caption text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span>
                  {toRoman(number)}. {titleCase(module.module_name)}
                </span>
                {/* Chevron greys to #BFBFBF (neutral-400) while the trigger is hovered. */}
                <Icon
                  icon={MdExpandMore}
                  size={24}
                  className={cn(
                    "shrink-0 transition duration-fast group-hover:text-neutral-400",
                    open && "rotate-180"
                  )}
                />
              </AccordionPrimitive.Trigger>
            </AccordionPrimitive.Header>
          </div>
          <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none">
            <div className="border-t border-border rounded-b bg-background text-caption leading-7 text-foreground">
              {/* Read-only module summary (Figma 859:7479). */}
              <div className="flex flex-col gap-2.5 px-6 py-4">
                <SummaryRow label="Module name">{titleCase(module.module_name)}</SummaryRow>
                <SummaryRow label="Concept">{conceptName ? titleCase(conceptName) : "—"}</SummaryRow>
                <SummaryRow label="Reference">{referenceValue}</SummaryRow>
                <div className="flex flex-col">
                  <p className="font-semibold text-foreground">Uploaded files</p>
                  {filesQuery.isLoading ? (
                    <p className="text-foreground">Loading…</p>
                  ) : uploadedFiles.length ? (
                    <div className="text-sm leading-7 text-foreground">
                      {uploadedFiles.map((f) => (
                        <p key={f.file_id ?? f.fileName}>{f.fileName}</p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-foreground">None</p>
                  )}
                </div>
                <div className="flex flex-col">
                  <p className="font-semibold text-foreground">Module prompt</p>
                  <p className="whitespace-pre-wrap text-foreground">{module.module_prompt || "No prompt set."}</p>
                </div>
                <SummaryRow label="Key topics">{topics.length ? topics.join("; ") : "None"}</SummaryRow>
              </div>
              {/* Footer: Delete module (left) / Edit (right), per the mockup. */}
              <div className="flex items-center justify-between border-t border-border px-6 py-0.5">
                <Button variant="link" className="p-0 text-destructive leading-7" onClick={() => onDelete(module)}>
                  Delete module
                </Button>
                <Button variant="link" className="p-0 leading-7" onClick={() => onEdit(module)}>
                  Edit
                </Button>
              </div>
            </div>
          </AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      </AccordionPrimitive.Root>
    </div>
  )
}

/**
 * Configuration tree entry for ONE concept (Figma 365:2504): a clean concept
 * box — `N. Name` + an inline rename pencil — over its module boxes, which sit
 * indented BELOW the concept box (not nested inside it). The concept drag handle
 * sits up front (always visible for discoverability); rename is inline, and
 * delete is revealed on hover/focus. The concept-level drag handle is wired by
 * the parent via `sortable` (from its `useSortable`); module reordering is
 * self-contained here.
 *
 * @param {{
 *   concept: { concept_id: string, concept_name: string, concept_number?: number },
 *   modules?: Array<object>,
 *   number?: number,
 *   courseId?: string,
 *   sortable?: { setNodeRef?: Function, style?: object, attributes?: object, listeners?: object, isDragging?: boolean },
 *   onRename: (name: string) => void,
 *   onDelete: () => void,
 *   onReorderModules: (ordered: Array<object>) => void,
 *   onEditModule: (module: object) => void,
 *   onDeleteModule: (module: object) => void,
 * }} props
 */
export function ModuleAccordion({
  concept,
  modules = [],
  number,
  courseId,
  sortable,
  onRename,
  onDelete,
  onReorderModules,
  onEditModule,
  onDeleteModule,
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(concept.concept_name)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const moduleIds = modules.map((m) => m.module_id)
  const displayNumber = number ?? concept.concept_number

  const handleModuleDragEnd = (event) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = moduleIds.indexOf(active.id)
    const newIndex = moduleIds.indexOf(over.id)
    if (oldIndex < 0 || newIndex < 0) return
    onReorderModules(arrayMove(modules, oldIndex, newIndex))
  }

  const saveName = () => {
    const next = name.trim()
    if (next && next !== concept.concept_name) onRename(next)
    setEditing(false)
  }

  return (
    <div
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      className={cn("flex flex-col gap-2", sortable?.isDragging && "opacity-50")}
    >
      {/* Concept box — clean at rest (number + name + pencil); controls on hover. */}
      <div className="group flex items-center gap-2 rounded-sm border border-border bg-muted px-3 py-1 max-w-[600px]">
        {editing ? (
          <div className="flex flex-1 items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Concept name"
              maxLength={50}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName()
                if (e.key === "Escape") {
                  setName(concept.concept_name)
                  setEditing(false)
                }
              }}
            />
            <Button size="icon" variant="ghost" aria-label="Save concept name" onClick={saveName}>
              <Icon icon={MdCheck} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Cancel rename"
              onClick={() => {
                setName(concept.concept_name)
                setEditing(false)
              }}
            >
              <Icon icon={MdClose} />
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Reorder ${concept.concept_name}`}
              className="cursor-grab touch-none rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              {...(sortable?.attributes || {})}
              {...(sortable?.listeners || {})}
            >
              <Icon icon={MdDragIndicator} size={24} />
            </button>
            <h3 className="text-caption leading-7 text-neutral-900">
              {displayNumber != null ? `${displayNumber}. ` : ""}
              {titleCase(concept.concept_name)}
            </h3>
            <button
              type="button"
              aria-label="Rename concept"
              onClick={() => {
                setName(concept.concept_name)
                setEditing(true)
              }}
              className="leading-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={MdEdit} size={18} />
            </button>
            <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <button
                type="button"
                aria-label="Delete concept"
                onClick={onDelete}
                className="rounded text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={MdDelete} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Module boxes — same 600px width as the concept box, but right-aligned
          (concepts float left, modules float right) per the Configuration mockup. */}
      {modules.length > 0 && (
        <div className="flex flex-col items-end gap-2">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleModuleDragEnd}>
            <SortableContext items={moduleIds} strategy={verticalListSortingStrategy}>
              {modules.map((m, i) => (
                <SortableModuleRow
                  key={m.module_id}
                  module={m}
                  number={i + 1}
                  courseId={courseId}
                  conceptName={concept.concept_name}
                  onEdit={onEditModule}
                  onDelete={onDeleteModule}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </div>
  )
}
