import { useState } from "react"
import { MdCancel, MdCheck, MdExpandMore } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/** Order-independent equality for two value arrays. */
const sameSet = (a, b) => a.length === b.length && a.every((v) => b.includes(v))

/**
 * Multi-select dropdown (OCELIA `Selection/Multi`). The trigger opens a popover
 * checklist whose ticks are STAGED locally and only committed on `Apply` (or
 * reset with `Clear`); dismissing without applying discards the draft. Once a
 * selection is committed and the popover is closed, the trigger shows
 * `placeholder (n)` in the brand colour with a clear (×) button. Controlled via
 * `value` (array of selected values) + `onChange(next)`. Pass `disabled` to
 * lock the control (e.g. when there are no options to choose from).
 *
 * @param {{
 *   options: Array<{ value: string, label: string }>,
 *   value: string[],
 *   onChange: (next: string[]) => void,
 *   placeholder?: string,
 *   emptyText?: string,
 *   disabled?: boolean,
 *   id?: string,
 *   "aria-label"?: string,
 *   className?: string,
 *   triggerClassName?: string,
 * }} props
 */
export function MultiSelect({
  options = [],
  value = [],
  onChange,
  placeholder = "Select…",
  emptyText = "No options available.",
  disabled = false,
  id,
  "aria-label": ariaLabel,
  className,
  triggerClassName,
}) {
  const [open, setOpen] = useState(false)
  // Staged selection: reseeded from the committed `value` each time the popover
  // opens, mutated by the checklist, and pushed up via `onChange` only on Apply.
  const [draft, setDraft] = useState(value)

  const handleOpenChange = (next) => {
    if (next) setDraft(value) // reseed from the committed value whenever we open
    setOpen(next)
  }

  const toggle = (v) =>
    setDraft((d) => (d.includes(v) ? d.filter((x) => x !== v) : [...d, v]))

  const apply = () => {
    onChange(draft)
    setOpen(false)
  }

  const draftSet = new Set(draft)
  // The committed count + clear (×) only show on the CLOSED trigger; while open,
  // the trigger reads as the plain placeholder (matches the mockup states).
  const showValue = value.length > 0 && !open
  const clearEnabled = draft.length > 0
  const applyEnabled = !sameSet(draft, value)

  // Disabled Clear/Apply use the neutral "inactive" grey (#BFBFBF) from the
  // mockup instead of the Button's default faded-brand disabled state.
  const disabledOutline =
    "disabled:opacity-100 disabled:border-neutral-400 disabled:bg-background disabled:text-neutral-400"
  const disabledSolid = "disabled:opacity-100 disabled:bg-neutral-400 disabled:text-white"

  return (
    <div className={cn("flex flex-col", className)}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <div className="relative w-full">
          <PopoverTrigger
            id={id}
            type="button"
            aria-label={ariaLabel}
            disabled={disabled}
            className={cn(
              // Border turns brand purple (#6829C2 / primary) when the trigger is
              // clicked: while the menu is open (data-state) and while it holds focus. No wrapping ring.
              "flex h-10 w-full items-center justify-between gap-2 rounded-none border border-input bg-background px-3 py-2 text-caption text-foreground focus:border-primary data-[state=open]:border-primary focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              triggerClassName
            )}
          >
            <span className={cn("truncate", showValue ? "font-semibold text-primary" : "text-muted-foreground")}>
              {showValue ? `${placeholder} (${value.length})` : placeholder}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {/* Reserves room for the overlaid clear (×) so the chevron doesn't
                  shift when a value is committed. */}
              {showValue && <span aria-hidden className="h-6 w-6" />}
              <Icon
                icon={MdExpandMore}
                size={24}
                className={cn("transition duration-fast", open && "rotate-180")}
              />
            </span>
          </PopoverTrigger>
          {/* Sibling (not nested) so it's valid inside the trigger <button> and
              its click clears the committed value without opening the popover. */}
          {showValue && (
            <button
              type="button"
              aria-label={`Clear ${ariaLabel ?? "selection"}`}
              onClick={() => onChange([])}
              disabled={disabled}
              className="absolute right-9 top-1/2 -translate-y-1/2 text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon icon={MdCancel} size={24} />
            </button>
          )}
        </div>
        {/* Rendered in place (not portaled) so the dropdown stays inside a modal
            Dialog's DOM subtree — a portaled popover lands in the region the
            Dialog marks `pointer-events: none`, which blocks option clicks +
            outside-click dismissal (CreateCourse). */}
        <PopoverContent portal={false} align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          {options.length === 0 ? (
            <p className="px-4 py-3 text-caption text-muted-foreground">{emptyText}</p>
          ) : (
            <>
              <ul className="flex max-h-60 flex-col overflow-y-auto py-2">
                {options.map((o) => {
                  const checked = draftSet.has(o.value)
                  return (
                    <li key={o.value}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        onClick={() => toggle(o.value)}
                        // 44px rows with the #F2E8FF (primary-subtle) hover surface —
                        // matches the `Selection/Multi/Option` mockup and keeps the
                        // option-hover affordance consistent with the single Select.
                        className="flex w-full items-center gap-2 px-4 py-3 text-left text-caption text-foreground transition-colors hover:bg-primary-subtle focus-visible:bg-primary-subtle focus-visible:outline-none"
                      >
                        <span
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-none border",
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-input bg-background"
                          )}
                        >
                          {checked && <Icon icon={MdCheck} size={12} />}
                        </span>
                        <span className="truncate">{o.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              <div className="flex flex-col gap-4 px-4 pb-4">
                <div className="h-px w-full bg-border" />
                <div className="flex gap-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDraft([])}
                    disabled={!clearEnabled}
                    className={cn("h-7 flex-1", disabledOutline)}
                  >
                    Clear
                  </Button>
                  <Button
                    type="button"
                    onClick={apply}
                    disabled={!applyEnabled}
                    className={cn("h-7 flex-1", disabledSolid)}
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}
