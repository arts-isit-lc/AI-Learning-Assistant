import { MdCheckCircle, MdMenuBook, MdExpandMore } from "react-icons/md"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"

/**
 * Learning Journey bar (Figma course + module-chat frames): label + overall
 * status + `NN% (x/y concepts completed)`, with a book/chevron trigger that
 * opens the per-concept progress drawer. Shared by CourseView + StudentChat.
 *
 * The top/bottom border is FULL-BLEED — it spans the entire viewport width (the
 * frames run the drawer edge-to-edge) via a `w-screen` break-out, while the
 * content re-centers to the page's `max-w-7xl`. Hosts pass `contentClassName`
 * to match their own gutter (StudentChat uses `px-6`; CourseView has none).
 * StudentLayout's `<main>` carries `overflow-x-clip` so the vw/scrollbar
 * overshoot from the break-out never introduces a horizontal scrollbar.
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
  const status =
    percent === 100
      ? { label: "COMPLETED", cls: "text-success" }
      : percent === 0
        ? { label: "NOT STARTED", cls: "text-muted-foreground" }
        : { label: "IN PROGRESS", cls: "text-info" }

  return (
    <div className="relative left-1/2 w-screen -translate-x-1/2 border-y border-border">
      <div
        className={cn(
          "mx-auto flex w-full max-w-7xl items-center justify-between gap-4 py-4",
          contentClassName
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-caption font-semibold text-neutral-900">Learning Journey</span>
          <span className={cn("text-caption font-semibold uppercase", status.cls)}>{status.label}</span>
          <span className="text-caption text-foreground">
            {percent}% ({completedConcepts}/{totalConcepts} concepts completed)
          </span>
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <button
              type="button"
              aria-label="Learning journey"
              className="inline-flex items-center gap-1 rounded-sm p-1 text-primary transition-colors hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon icon={MdMenuBook} size={20} />
              <Icon icon={MdExpandMore} size={18} />
            </button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Learning journey</SheetTitle>
            </SheetHeader>
            <ul className="mt-4 flex flex-col gap-4 overflow-y-auto">
              {concepts.map((concept, i) => (
                <li key={concept.concept_id} className="flex items-center gap-3">
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
                    <span className="truncate text-caption font-semibold text-foreground">
                      {titleCase(concept.concept_name)}
                    </span>
                    <span className="text-caption text-muted-foreground">
                      {concept.completedModules}/{concept.totalModules} modules complete
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  )
}
