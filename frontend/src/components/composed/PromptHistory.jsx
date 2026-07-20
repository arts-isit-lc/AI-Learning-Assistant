import { useState } from "react"
import { MdChevronLeft, MdChevronRight } from "react-icons/md"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { ScrollArea } from "@/components/ui/scroll-area"

function formatTimestamp(ts) {
  if (!ts) return ""
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

/**
 * Prompt version history (`previous_prompts`). A compact stepper over prior
 * versions with an optional restore action.
 *
 * @param {{ versions?: Array<{ previous_prompt: string, timestamp?: string }>, onRestore?: (text: string) => void }} props
 */
export function PromptHistory({ versions = [], onRestore }) {
  const [index, setIndex] = useState(0)
  if (versions.length === 0) {
    return <p className="text-caption text-muted-foreground">No previous versions yet.</p>
  }

  const safeIndex = Math.min(index, versions.length - 1)
  const version = versions[safeIndex]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous version"
            disabled={safeIndex === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            <Icon icon={MdChevronLeft} />
          </Button>
          <span className="text-caption text-muted-foreground">
            Version {safeIndex + 1} of {versions.length}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next version"
            disabled={safeIndex === versions.length - 1}
            onClick={() => setIndex((i) => Math.min(versions.length - 1, i + 1))}
          >
            <Icon icon={MdChevronRight} />
          </Button>
        </div>
        {onRestore && (
          <Button size="sm" variant="outline" onClick={() => onRestore(version.previous_prompt)}>
            Restore
          </Button>
        )}
      </div>
      {version.timestamp && (
        <p className="text-caption text-muted-foreground">{formatTimestamp(version.timestamp)}</p>
      )}
      <ScrollArea className="max-h-40 rounded-md border border-border p-3">
        <p className="whitespace-pre-wrap text-caption text-foreground">{version.previous_prompt}</p>
      </ScrollArea>
    </div>
  )
}
