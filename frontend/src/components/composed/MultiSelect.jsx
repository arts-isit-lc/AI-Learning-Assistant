import { useState } from "react"
import { MdCheck, MdExpandMore } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tag } from "@/components/composed/Tag"

/**
 * Multi-select dropdown. A trigger opens a popover list of toggle options
 * (each an `aria-pressed` button); the selection renders below as removable
 * tags. Controlled via `value` (array of selected values) + `onChange(next)`.
 *
 * @param {{
 *   options: Array<{ value: string, label: string }>,
 *   value: string[],
 *   onChange: (next: string[]) => void,
 *   placeholder?: string,
 *   emptyText?: string,
 *   id?: string,
 *   "aria-label"?: string,
 *   className?: string,
 * }} props
 */
export function MultiSelect({
  options = [],
  value = [],
  onChange,
  placeholder = "Select…",
  emptyText = "No options available.",
  id,
  "aria-label": ariaLabel,
  className,
  triggerClassName,
}) {
  const [open, setOpen] = useState(false)
  const selected = new Set(value)
  const labelFor = (v) => options.find((o) => o.value === v)?.label ?? v

  const toggle = (v) =>
    onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v])

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          type="button"
          aria-label={ariaLabel}
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 rounded-none border border-input bg-background px-3 py-2 text-caption text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName
          )}
        >
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? placeholder : `${value.length} selected`}
          </span>
          <Icon icon={MdExpandMore} size={24} className="shrink-0" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
          {options.length === 0 ? (
            <p className="px-2 py-3 text-caption text-muted-foreground">{emptyText}</p>
          ) : (
            <ul className="flex max-h-60 flex-col overflow-y-auto">
              {options.map((o) => {
                const checked = selected.has(o.value)
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      aria-pressed={checked}
                      onClick={() => toggle(o.value)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-caption text-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                          checked ? "bg-primary text-primary-foreground" : "bg-background"
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
          )}
        </PopoverContent>
      </Popover>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <Tag key={v} label={labelFor(v)} onRemove={() => toggle(v)} />
          ))}
        </div>
      )}
    </div>
  )
}
