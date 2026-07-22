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
import {
  MdDragIndicator,
  MdEdit,
  MdAdd,
  MdDelete,
  MdCheck,
  MdClose,
  MdExpandMore,
} from "react-icons/md"
import { cn } from "@/lib/utils"
import { titleCase, toRoman } from "@/utils/formatters"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tag } from "@/components/composed/Tag"

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

/**
 * One module: an indented, sortable box (Figma 365:2504) showing `i. Name` + a
 * disclosure chevron, expanding to a read-only summary + Edit/Delete. The drag
 * handle is revealed on hover/focus so the row reads clean at rest like the
 * mockup. `number` is the module's 1-based position (rendered as a roman numeral).
 */
function SortableModuleRow({ module, number, onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: module.module_id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const topics = parseKeyTopics(module.key_topics)

  return (
    <div ref={setNodeRef} style={style} className="group/module rounded-sm border border-border bg-muted">
      <div className="flex items-center gap-2 py-2 pl-3 pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center justify-between gap-2 rounded py-1 text-left text-caption text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>
            {toRoman(number)}. {titleCase(module.module_name)}
          </span>
          <Icon icon={MdExpandMore} size={18} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        <button
          type="button"
          aria-label={`Reorder ${module.module_name}`}
          className="cursor-grab touch-none rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/module:opacity-100"
          {...attributes}
          {...listeners}
        >
          <Icon icon={MdDragIndicator} size={18} />
        </button>
      </div>
      {open && (
        <div className="border-t border-border bg-background p-3 text-caption">
          <p className="font-semibold text-foreground">Prompt</p>
          <p className="mb-3 whitespace-pre-wrap text-muted-foreground">
            {module.module_prompt || "No prompt set."}
          </p>
          {topics.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {topics.map((t, i) => (
                <Tag key={i} label={t} />
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onEdit(module)}>
              Edit
            </Button>
            <Button size="sm" variant="danger" onClick={() => onDelete(module)}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Configuration tree entry for ONE concept (Figma 365:2504): a clean concept
 * box — `N. Name` + an inline rename pencil — over its module boxes, which sit
 * indented BELOW the concept box (not nested inside it). Management controls
 * (reorder handle, add-module, delete) are revealed on hover/focus so the row
 * reads clean at rest like the mockup. The concept-level drag handle is wired by
 * the parent via `sortable` (from its `useSortable`); module reordering is
 * self-contained here.
 *
 * @param {{
 *   concept: { concept_id: string, concept_name: string, concept_number?: number },
 *   modules?: Array<object>,
 *   number?: number,
 *   sortable?: { setNodeRef?: Function, style?: object, attributes?: object, listeners?: object, isDragging?: boolean },
 *   onRename: (name: string) => void,
 *   onDelete: () => void,
 *   onAddModule: () => void,
 *   onReorderModules: (ordered: Array<object>) => void,
 *   onEditModule: (module: object) => void,
 *   onDeleteModule: (module: object) => void,
 * }} props
 */
export function ModuleAccordion({
  concept,
  modules = [],
  number,
  sortable,
  onRename,
  onDelete,
  onAddModule,
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
      <div className="group flex items-center gap-2 rounded-sm border border-border bg-muted px-3 py-1">
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
              className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={MdEdit} size={16} />
            </button>
            <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <button
                type="button"
                aria-label={`Reorder ${concept.concept_name}`}
                className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                {...(sortable?.attributes || {})}
                {...(sortable?.listeners || {})}
              >
                <Icon icon={MdDragIndicator} size={18} />
              </button>
              <button
                type="button"
                aria-label="Add module"
                onClick={onAddModule}
                className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={MdAdd} size={18} />
              </button>
              <button
                type="button"
                aria-label="Delete concept"
                onClick={onDelete}
                className="rounded p-1 text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={MdDelete} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Module boxes — indented below the concept box (not nested inside it). */}
      {modules.length > 0 && (
        <div className="ml-6 flex flex-col gap-2">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleModuleDragEnd}>
            <SortableContext items={moduleIds} strategy={verticalListSortingStrategy}>
              {modules.map((m, i) => (
                <SortableModuleRow
                  key={m.module_id}
                  module={m}
                  number={i + 1}
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
