import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function formatTimestamp(ts) {
  if (!ts) return ""
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

/**
 * Prompt version history (`previous_prompts`) — OCELIA `Prompt/View Previous`
 * (Figma 859:7852). A scannable list of prior prompt versions: each entry shows
 * its timestamp/identifier (12px semibold) over the full prompt text (18px body).
 *
 * Two-step restore (per the mockup). Hovering or selecting an entry tints it with
 * the lavender selected surface (`primary-subtle`, #F2E8FF) and a primary border
 * at a 4px radius. Clicking an entry selects it and reveals a **Use prompt**
 * button; clicking that button restores that version into the editor via
 * `onRestore`. The transparent default border keeps the hover/selected border
 * from shifting the layout. Selecting a row never restores on its own — only the
 * explicit **Use prompt** action does, so a stray click can't overwrite the
 * editor.
 *
 * @param {{ versions?: Array<{ previous_prompt: string, timestamp?: string }>, onRestore?: (text: string) => void, disabled?: boolean }} props
 */
export function PromptHistory({ versions = [], onRestore, disabled = false }) {
  // Index of the expanded entry (the one showing its "Use prompt" action).
  const [selected, setSelected] = useState(null)

  // Drop the selection when the list changes (e.g. a save prepends a new
  // version) so the action never lands on a shifted entry.
  useEffect(() => {
    setSelected(null)
  }, [versions.length])

  if (versions.length === 0) {
    return <p className="text-caption text-muted-foreground">No previous versions yet.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {versions.map((version, i) => {
        // Newest first (index 0), so the version-number fallback counts down.
        const label = formatTimestamp(version.timestamp) || `Version ${versions.length - i}`
        const isSelected = selected === i
        return (
          // `relative` anchors the Use prompt button, which overlays the top-right
          // of the card as a sibling (never nested inside the select button).
          <li key={i} className="relative">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setSelected((cur) => (cur === i ? null : i))}
              aria-expanded={isSelected}
              aria-label={`Prompt from ${label}`}
              className={cn(
                "flex w-full flex-col gap-2.5 rounded-sm border border-transparent p-2.5 text-left transition-colors",
                "hover:border-primary hover:bg-primary-subtle",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isSelected && "border-primary bg-primary-subtle",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-transparent disabled:hover:bg-transparent"
              )}
            >
              <span className="text-xs font-semibold leading-7 text-foreground">{label}</span>
              <span className="whitespace-pre-wrap text-body text-foreground">{version.previous_prompt}</span>
            </button>
            {isSelected && (
              <Button
                size="sm"
                disabled={disabled}
                onClick={() => onRestore?.(version.previous_prompt)}
                aria-label={`Use prompt from ${label}`}
                className="absolute right-2.5 top-2.5 h-7 shrink-0 rounded px-6"
              >
                Use prompt
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
