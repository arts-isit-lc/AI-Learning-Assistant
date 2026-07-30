import { useState } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion"

function isModuleSource(src) {
  return typeof src === "string" && src.startsWith("module_prompt:")
}

/** Human label for a prompt source ("system_prompt" -> "System prompt"). */
function sourceLabel(src) {
  if (src === "course_prompt") return "Course prompt"
  if (src === "system_prompt") return "System prompt"
  if (isModuleSource(src)) return `Module: ${src.replace("module_prompt:", "")}`
  return src || "Prompt"
}

/** The prompt this one clashes WITH (the non-course side), for the row summary. */
function conflictWith(conflict) {
  const other =
    [conflict.prompt_a_source, conflict.prompt_b_source].find((s) => s && s !== "course_prompt") ||
    conflict.prompt_b_source ||
    conflict.prompt_a_source
  if (other === "system_prompt") return "system level prompt"
  if (isModuleSource(other)) return `module: ${other.replace("module_prompt:", "")}`
  return other || "another prompt"
}

// Display labels for the four backend conflict types (UBC/Canadian spelling per
// the Figma frames). Only HARD_CONTRADICTION is rendered red; the rest mustard.
const TYPE_LABELS = {
  HARD_CONTRADICTION: "HARD CONTRADICTION",
  BEHAVIORAL_INCOMPATIBILITY: "BEHAVIOURAL INCOMPATIBILITY",
  CONSTRAINT_COLLISION: "CONSTRAINT COLLISION",
  HIERARCHY_VIOLATION: "HIERARCHY VIOLATION",
}

/** Figma severity pill label for a conflict type (falls back to a spaced enum). */
function severityLabel(conflict) {
  return TYPE_LABELS[conflict.type] || String(conflict.type || "CONFLICT").replace(/_/g, " ")
}

/**
 * The conflict list under a prompt (Figma Settings/C + AddModule/Step3/A): each
 * conflict is a collapsible row — a solid severity pill + "Conflicts with:
 * <source>" — that expands to the explanation and the two clashing prompt texts.
 * A low-confidence toggle reveals softer, model-only matches. Renders nothing
 * when the report has no conflicts.
 *
 * @param {{ report: object|null, className?: string }} props
 */
export function ConflictList({ report, className }) {
  const [showLowConfidence, setShowLowConfidence] = useState(false)

  if (!report?.has_conflicts) return null
  const all = report.conflicts || []
  const visible = all.filter((c) => showLowConfidence || c.severity !== "low_confidence_llm")
  const lowConfidenceCount = all.filter((c) => c.severity === "low_confidence_llm").length
  if (visible.length === 0 && lowConfidenceCount === 0) return null

  return (
    <div className={cn("mt-3 flex flex-col gap-2", className)}>
      <Accordion type="multiple" className="flex flex-col gap-2">
        {visible.map((c, i) => (
          <AccordionItem key={i} value={String(i)} className="border-b-0">
            <AccordionTrigger className="gap-3 py-1 hover:no-underline">
              <span className="flex flex-1 items-center gap-3 text-left">
                <span
                  className={cn(
                    // All severity pills use a white label on a solid fill; only
                    // the fill differs by type (destructive red vs warning mustard).
                    "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase text-white",
                    c.type === "HARD_CONTRADICTION" ? "bg-destructive" : "bg-warning"
                  )}
                >
                  {severityLabel(c)}
                </span>
                <span className="text-xs leading-7 text-foreground">
                  Conflicts with: <span className="font-semibold">{conflictWith(c)}</span>
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              {c.explanation && <p className="mb-2 text-xs leading-7 text-foreground">{c.explanation}</p>}
              {c.prompt_a_text && (
                <p className="text-xs leading-7 text-muted-foreground">
                  <span className="font-semibold">{sourceLabel(c.prompt_a_source)}:</span> {c.prompt_a_text}
                </p>
              )}
              {c.prompt_b_text && (
                <p className="text-xs leading-7 text-muted-foreground">
                  <span className="font-semibold">{sourceLabel(c.prompt_b_source)}:</span> {c.prompt_b_text}
                </p>
              )}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
      {lowConfidenceCount > 0 && (
        <Button
          variant="link"
          size="sm"
          className="self-start px-0"
          onClick={() => setShowLowConfidence((s) => !s)}
        >
          {showLowConfidence
            ? "Hide low-confidence conflicts"
            : `Show ${lowConfidenceCount} low-confidence conflict(s)`}
        </Button>
      )}
    </div>
  )
}
