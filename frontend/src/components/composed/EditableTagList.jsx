import { useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Tag } from "./Tag"
import { Input } from "@/components/ui/input"

/**
 * A wrap of removable pills whose values can be edited in place by clicking one.
 *
 * Controlled: the parent owns `values` and receives the next array via `onChange`.
 * Clicking a tag swaps it for an inline input — Enter or blur commits, Escape
 * cancels. Committing an empty value removes the tag; a case-insensitive
 * duplicate of another value merges away (the edited one is dropped); otherwise
 * the value is replaced in place (order preserved). Renders nothing when empty.
 *
 * @param {{
 *   values: string[],
 *   onChange: (next: string[]) => void,
 *   ariaLabelPrefix?: string,
 *   className?: string,
 * }} props
 */
export function EditableTagList({ values, onChange, ariaLabelPrefix = "item", className }) {
  const [editing, setEditing] = useState(null) // the original value currently being edited
  const [draft, setDraft] = useState("")
  // Escape sets this so the blur it triggers doesn't re-commit the edit.
  const cancelledRef = useRef(false)

  if (!values.length) return null

  const startEdit = (value) => {
    cancelledRef.current = false
    setEditing(value)
    setDraft(value)
  }

  const cancelEdit = () => {
    cancelledRef.current = true
    setEditing(null)
    setDraft("")
  }

  const commitEdit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    if (editing === null) return
    const next = draft.trim()
    const withoutOriginal = values.filter((v) => v !== editing)
    if (!next) {
      onChange(withoutOriginal) // emptied -> remove the tag
    } else if (withoutOriginal.some((v) => v.toLowerCase() === next.toLowerCase())) {
      onChange(withoutOriginal) // duplicates another value -> merge away
    } else {
      onChange(values.map((v) => (v === editing ? next : v))) // replace in place
    }
    setEditing(null)
    setDraft("")
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {values.map((value) =>
        editing === value ? (
          <Input
            key={value}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commitEdit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                cancelEdit()
              }
            }}
            onBlur={commitEdit}
            aria-label={`Edit ${ariaLabelPrefix}`}
            className="h-8 w-44"
          />
        ) : (
          <Tag
            key={value}
            label={value}
            onClick={() => startEdit(value)}
            onRemove={() => onChange(values.filter((v) => v !== value))}
          />
        )
      )}
    </div>
  )
}
