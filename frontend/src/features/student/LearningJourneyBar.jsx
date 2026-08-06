import { useId, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { MdCheckCircle, MdMap, MdExpandMore, MdExpandLess, MdChevronRight } from "react-icons/md"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Collapse } from "@/components/ui/collapse"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Learning Journey bar (Figma course + module-chat frames): label + overall
 * status + `NN% (x/y concepts completed)`, with a map/chevron trigger that
 * expands the progress tracker *inline, right below the bar* (an accordion, not
 * a right-side drawer). Expanded, it lists every concept and — nested beneath
 * each — that concept's modules with their completion state, mirroring the
 * expanded `Concept` card. Shared by CourseView + StudentChat.
 *
 * The top/bottom border is FULL-BLEED — it spans the entire viewport width (the
 * frames run the bar edge-to-edge) via a `w-screen` break-out, while the content
 * re-centers to the page's `max-w-7xl`. Hosts pass `contentClassName` to match
 * their own gutter (StudentChat uses `px-6`; CourseView has none). When expanded,
 * the panel grows *inside* the bordered region so the bottom border tracks the
 * bottom of the progress list. StudentLayout's `<main>` carries `overflow-x-clip`
 * so the vw/scrollbar overshoot from the break-out never adds a horizontal bar.
 *
 * `fullBleed` (default true) owns that edge-to-edge top+bottom rule. Pass
 * `fullBleed={false}` when the host wraps the bar in its own full-bleed,
 * `overflow-hidden` slide container (CourseView's Reduce/Expand): the bar then
 * renders only a top rule (the wrapper supplies the full-bleed span + bottom
 * rule), so `overflow-hidden` can clip the height animation without cropping the
 * edge-to-edge divider.
 *
 * While `loading`, the status + `NN% (x/y concepts completed)` summary renders as
 * a skeleton and the tracker toggle is disabled, so the bar never shows a stale
 * "NOT STARTED · 0%" before the real progress arrives.
 *
 * @param {{ concepts?: Array, completedConcepts?: number, totalConcepts?: number, percent?: number, loading?: boolean, contentClassName?: string, fullBleed?: boolean }} props
 */
export function LearningJourneyBar({
  concepts = [],
  completedConcepts = 0,
  totalConcepts = 0,
  percent = 0,
  loading = false,
  contentClassName,
  fullBleed = true,
}) {
  const { courseId } = useParams()
  const [open, setOpen] = useState(false)
  const panelId = useId()

  const status =
    percent === 100
      ? { label: "COMPLETED", cls: "text-success" }
      : percent === 0
        ? { label: "NOT STARTED", cls: "text-muted-foreground" }
        : { label: "IN PROGRESS", cls: "text-info" }

  return (
    <div
      className={cn(
        fullBleed
          ? "relative left-1/2 w-screen -translate-x-1/2 border-y border-border"
          : // Embedded in a host slide wrapper that owns the full-bleed span +
            // bottom rule; render only the top rule here.
            "border-t border-border"
      )}
    >
      <div className={cn("mx-auto w-full max-w-7xl pt-4", contentClassName)}>
        <div className="flex items-center justify-between gap-4 pb-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-lg leading-7 font-semibold text-neutral-900">Learning Journey</span>
            {loading ? (
              // Progress is still resolving — skeleton the status + summary instead
              // of flashing "NOT STARTED · 0% (0/0)".
              <span role="status" aria-label="Loading progress" className="flex items-center">
                <Skeleton className="h-5 w-60" />
              </span>
            ) : (
              <>
                <span className={cn("text-base leading-7 font-semibold uppercase", status.cls)}>{status.label}</span>
                <span className="text-caption text-foreground leading-7">
                  {percent}% ({completedConcepts}/{totalConcepts} concepts completed)
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            aria-label="Learning journey"
            aria-expanded={open}
            aria-controls={panelId}
            disabled={loading}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-sm p-1 text-primary transition-colors hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <Icon icon={MdMap} size={20} />
            <Icon icon={open ? MdExpandLess : MdExpandMore} size={24} />
          </button>
        </div>

        {/* Concept tracker — slides open/closed via the shared Collapse
            primitive (same motion as every accordion). Force-closed while loading
            (there are no concepts to list yet, and the toggle is disabled). */}
        <Collapse open={open && !loading}>
          <div id={panelId} className="relative mt-4">
            <ul className="flex gap-6 overflow-x-auto pr-10">
              {concepts.map((concept, i) => (
                <li key={concept.concept_id} className="flex min-w-[180px] shrink-0 pb-6 flex-col gap-3 border-r border-border pr-6 last:border-r-0">
                  <div className="flex items-center gap-3">
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                        concept.isComplete
                          ? "bg-success text-success-foreground"
                          : "border border-neutral-900 bg-transparent text-neutral-900"
                      )}
                    >
                      {concept.isComplete ? <Icon icon={MdCheckCircle} size={16} label="Complete" /> : i + 1}
                    </span>
                    <div className="flex min-w-0 flex-col">
                      <span className="text-base leading-5 font-semibold text-neutral-900">
                        {titleCase(concept.concept_name)}
                      </span>
                    </div>
                  </div>

                  {concept.modules?.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {concept.modules.map((module) => (
                        <li key={module.module_id}>
                          <Link
                            to={`/courses/${courseId}/modules/${module.module_id}`}
                            className="rounded-[12.75px] border-[0.75px] px-1.5 py-[3px] border-primary bg-background text-[10.5px] text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                          >
                            {titleCase(module.module_name)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {/* Scroll hint — fades into a chevron on the right edge */}
            <div className="pointer-events-none absolute right-0 top-0 flex h-full w-10 items-center justify-end bg-gradient-to-l from-background to-transparent">
              <Icon icon={MdChevronRight} size={24} className="text-muted-foreground" />
            </div>
          </div>
        </Collapse>
      </div>
    </div>
  )
}
