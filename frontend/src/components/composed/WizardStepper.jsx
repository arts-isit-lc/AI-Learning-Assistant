import { MdCheck } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Module-wizard step indicator (Figma WizardStepper). Shows completed / current /
 * upcoming steps; the current step is exposed via `aria-current="step"`.
 *
 * @param {{ steps?: string[], current?: number, className?: string }} props
 */
export function WizardStepper({ steps = [], current = 0, className }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-2", className)} aria-label="Progress">
      {steps.map((label, i) => {
        const state = i < current ? "complete" : i === current ? "current" : "upcoming"
        return (
          <li
            key={label}
            className="flex items-center gap-2"
            aria-current={state === "current" ? "step" : undefined}
          >
            <span
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-caption font-semibold",
                state === "current" && "bg-primary text-primary-foreground",
                state === "complete" && "bg-success text-success-foreground",
                state === "upcoming" && "bg-muted text-muted-foreground"
              )}
            >
              {state === "complete" ? <Icon icon={MdCheck} size={16} /> : i + 1}
            </span>
            <span
              className={cn(
                "text-caption",
                state === "current" ? "font-semibold text-foreground" : "text-muted-foreground"
              )}
            >
              {label}
            </span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" aria-hidden="true" />}
          </li>
        )
      })}
    </ol>
  )
}
