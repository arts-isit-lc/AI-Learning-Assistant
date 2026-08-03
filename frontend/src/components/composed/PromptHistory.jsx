import { cn } from "@/lib/utils"

function formatTimestamp(ts) {
  if (!ts) return ""
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

/**
 * Prompt version history (`previous_prompts`) — OCELIA `Prompt/View Previous`
 * (expanded). A scannable list of prior prompt versions: each entry shows its
 * timestamp/identifier (12px, semibold) over the full prompt text (18px body),
 * with a divider between entries. The whole row is the restore control —
 * clicking an entry restores that version.
 *
 * @param {{ versions?: Array<{ previous_prompt: string, timestamp?: string }>, onRestore?: (text: string) => void, disabled?: boolean }} props
 */
export function PromptHistory({ versions = [], onRestore, disabled = false }) {
  if (versions.length === 0) {
    return <p className="text-caption text-muted-foreground">No previous versions yet.</p>
  }

  return (
    <ul className="flex flex-col">
      {versions.map((version, i) => {
        // Newest first (index 0), so the version-number fallback counts down.
        const label = formatTimestamp(version.timestamp) || `Version ${versions.length - i}`
        return (
          <li key={i} className="border-b border-border">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRestore?.(version.previous_prompt)}
              aria-label={`Restore prompt from ${label}`}
              className={cn(
                "flex w-full flex-col gap-2.5 rounded-sm p-2.5 text-left transition-colors",
                "hover:bg-primary-subtle focus-visible:bg-primary-subtle focus-visible:outline-none",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              )}
            >
              <span className="text-xs font-semibold leading-7 text-foreground">{label}</span>
              <span className="whitespace-pre-wrap text-body text-foreground">{version.previous_prompt}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
