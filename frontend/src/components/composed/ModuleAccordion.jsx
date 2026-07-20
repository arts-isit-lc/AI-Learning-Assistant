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
import { titleCase } from "@/utils/formatters"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
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

/** One module: a sortable row that expands to a read-only summary + Edit/Delete. */
function SortableModuleRow({ module, onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: module.module_id,
  })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  const topics = parseKeyTopics(module.key_topics)

  return (
    <div ref={setNodeRef} style={style} className="rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          aria-label={`Reorder ${module.module_name}`}
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...attributes}
          {...listeners}
        >
          <Icon icon={MdDragIndicator} size={18} />
        </button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center justify-between gap-2 rounded py-1 text-left text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{titleCase(module.module_name)}</span>
          <Icon icon={MdExpandMore} size={18} className={cn("transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && (
        <div className="border-t border-border p-3 text-caption">
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
 * Configuration tree row for ONE concept (Figma ModuleAccordion): a concept
 * header (drag handle + inline rename + add-module + delete) over its sortable
 * module rows. The concept-level drag handle is wired by the parent via
 * `sortable` (from its `useSortable`); module reordering is self-contained here.
 *
 * @param {{
 *   concept: { concept_id: string, concept_name: string, concept_number?: number },
 *   modules?: Array<object>,
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
    <Card ref={sortable?.setNodeRef} style={sortable?.style} className={cn("p-0", sortable?.isDragging && "opacity-50")}>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <button
          type="button"
          aria-label={`Reorder ${concept.concept_name}`}
          className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          {...(sortable?.attributes || {})}
          {...(sortable?.listeners || {})}
        >
          <Icon icon={MdDragIndicator} size={20} />
        </button>

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
            <h3 className="flex-1 text-h4 font-semibold text-navy">{titleCase(concept.concept_name)}</h3>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Rename concept"
              onClick={() => {
                setName(concept.concept_name)
                setEditing(true)
              }}
            >
              <Icon icon={MdEdit} />
            </Button>
            <Button size="sm" variant="ghost" onClick={onAddModule}>
              <Icon icon={MdAdd} size={18} /> Add module
            </Button>
            <Button size="icon" variant="ghost" aria-label="Delete concept" onClick={onDelete}>
              <Icon icon={MdDelete} className="text-destructive" />
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 p-3">
        {modules.length === 0 ? (
          <p className="text-caption text-muted-foreground">No modules yet. Add one to get started.</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleModuleDragEnd}>
            <SortableContext items={moduleIds} strategy={verticalListSortingStrategy}>
              {modules.map((m) => (
                <SortableModuleRow key={m.module_id} module={m} onEdit={onEditModule} onDelete={onDeleteModule} />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </Card>
  )
}
