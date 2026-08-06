import { MdBarChart } from "react-icons/md"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/**
 * Gate row showing one completion requirement with a check/cross indicator.
 */
function GateRow({ label, met, detail }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span
        className={cn(
          "mt-0.5 text-caption font-bold",
          met ? "text-success" : "text-muted-foreground"
        )}
        aria-hidden="true"
      >
        {met ? "\u2713" : "\u2717"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-caption font-medium text-foreground">{label}</p>
        {detail && (
          <p className="text-xs text-muted-foreground">{detail}</p>
        )}
      </div>
    </div>
  )
}

/**
 * Popover showing the module completion progress gates.
 *
 * Receives `sessionState` from the chatbot turn response which contains:
 *   - module_complete: bool
 *   - interactions: number
 *   - engagement_score: number (0-1)
 *   - concepts_discussed_count: number
 *   - module_concepts_count: number
 *   - required_concepts: number
 *   - missing_requirements: string[] (subset of ["interactions", "concept_coverage", "engagement"])
 *   - stage: string
 *
 * @param {{ sessionState: object|null }} props
 */
export function ProgressPopover({ sessionState }) {
  if (!sessionState) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Module progress">
            <Icon icon={MdBarChart} size={20} className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <h3 className="text-caption font-semibold text-foreground">Module Progress</h3>
          <p className="mt-2 text-xs text-muted-foreground">
            No progress data for this turn yet. Send a message and it will appear here once
            the assistant replies.
          </p>
        </PopoverContent>
      </Popover>
    )
  }

  const {
    module_complete,
    interactions = 0,
    engagement_score = 0,
    concepts_discussed_count = 0,
    module_concepts_count = 0,
    required_concepts = 1,
    missing_requirements = [],
    stage = "prior_knowledge",
  } = sessionState

  const interactionsMet = !missing_requirements.includes("interactions")
  const conceptsMet = !missing_requirements.includes("concept_coverage")
  const engagementMet = !missing_requirements.includes("engagement")

  // Overall progress: fraction of gates met (3 total)
  const gatesMet = [interactionsMet, conceptsMet, engagementMet].filter(Boolean).length
  const overallPercent = module_complete ? 100 : Math.round((gatesMet / 3) * 100)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Module progress"
          className={cn(module_complete && "text-success")}
        >
          <Icon icon={MdBarChart} size={20} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-caption font-semibold text-foreground">Module Progress</h3>
            {module_complete && (
              <span className="text-xs font-semibold text-success">Complete</span>
            )}
          </div>

          <Progress value={overallPercent} className="h-2" />

          <div className="space-y-1">
            <GateRow
              label="Interactions"
              met={interactionsMet}
              detail={`${interactions} / 5 minimum`}
            />
            <GateRow
              label="Topic coverage"
              met={conceptsMet}
              detail={`${concepts_discussed_count} / ${required_concepts} topics discussed (of ${module_concepts_count} total)`}
            />
            <GateRow
              label="Engagement"
              met={engagementMet}
              detail={`${Math.round(engagement_score * 100)}% (50% required)`}
            />
          </div>

          <div className="border-t border-border pt-2">
            <p className="text-xs text-muted-foreground">
              Stage: <span className="font-medium capitalize">{stage.replace("_", " ")}</span>
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
