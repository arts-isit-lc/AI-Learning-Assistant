import { useId, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { MdCheckCircle, MdRadioButtonUnchecked, MdMap, MdExpandMore, MdExpandLess } from "react-icons/md"
import { titleCase } from "@/utils/formatters"
import { getModuleStatus } from "@/utils/moduleStatus"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

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
 * @param {{ concepts?: Array, completedConcepts?: number, totalConcepts?: number, percent?: number, contentClassName?: string }} props
 */
export function LearningJourneyBar({
  concepts = [],
  completedConcepts = 0,
  totalConcepts = 0,
  percent = 0,
  contentClassName,
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
    <div className="relative left-1/2 w-screen -translate-x-1/2 border-y border-border">
      <div className={cn("mx-auto w-full max-w-7xl py-4", contentClassName)}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-lg leading-7 font-semibold text-neutral-900">Learning Journey</span>
            <span className={cn("text-base leading-7 font-semibold uppercase", status.cls)}>{status.label}</span>
            <span className="text-caption text-foreground leading-7">
              {percent}% ({completedConcepts}/{totalConcepts} concepts completed)
            </span>
          </div>
          <button
            type="button"
            aria-label="Learning journey"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-sm p-1 text-primary transition-colors hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon icon={MdMap} size={20} />
            <Icon icon={open ? MdExpandLess : MdExpandMore} size={18} />
          </button>
        </div>

        {open && (
          <ul id={panelId} className="mt-4 flex flex-col gap-6">
            {concepts.map((concept, i) => (
              <li key={concept.concept_id} className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                      concept.isComplete
                        ? "bg-success text-success-foreground"
                        : "bg-muted text-muted-foreground"
                    )}
                  >
                    {concept.isComplete ? <Icon icon={MdCheckCircle} size={16} label="Complete" /> : i + 1}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-base font-semibold text-foreground">
                      {titleCase(concept.concept_name)}
                    </span>
                  </div>
                </div>

                {concept.modules?.length > 0 && (
                  <ul className="ml-11 flex flex-col gap-2">
                    {concept.modules.map((module) => {
                      const complete = getModuleStatus(module) === "complete"
                      return (
                        <li
                          key={module.module_id}
                          className="flex items-center justify-between gap-3"
                        >
                          <Link
                            to={`/courses/${courseId}/modules/${module.module_id}`}
                            className="rounded-[12.75px] border-[0.75px] border-primary bg-background text-[10.5px] text-primary"
                          >
                            {titleCase(module.module_name)}
                          </Link>
                          {complete ? (
                            <Icon
                              icon={MdCheckCircle}
                              size={20}
                              className="shrink-0 text-success"
                              label="Complete"
                            />
                          ) : (
                            <Icon
                              icon={MdRadioButtonUnchecked}
                              size={18}
                              className="shrink-0 text-muted-foreground"
                              label="Not complete"
                            />
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
