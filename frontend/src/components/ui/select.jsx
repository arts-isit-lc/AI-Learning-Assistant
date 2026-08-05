import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { MdExpandMore } from "react-icons/md"
import { Icon } from "./icon"
import { cn } from "@/lib/utils"

const Select = SelectPrimitive.Root
const SelectGroup = SelectPrimitive.Group
const SelectValue = SelectPrimitive.Value

const SelectTrigger = React.forwardRef(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "group flex h-10 w-full items-center justify-between gap-2 rounded-none border border-input bg-background px-3 py-2 text-caption text-foreground",
        // Radix marks the trigger with data-placeholder while the placeholder is
        // shown (SelectValue is a span, so the native placeholder: pseudo never
        // applied) — grey it to match the other fields.
        // Border turns brand purple (#6829C2 / primary) when the trigger is clicked:
        // while the menu is open (data-state) and while it holds focus. No wrapping ring.
        "data-[placeholder]:text-muted-foreground focus:border-primary data-[state=open]:border-primary focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <Icon
          icon={MdExpandMore}
          size={24}
          className="shrink-0 transition duration-fast group-data-[state=open]:rotate-180"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

const SelectContent = React.forwardRef(function SelectContent(
  { className, children, position = "popper", sideOffset = 10, ...props },
  ref
) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "relative z-dropdown max-h-96 min-w-[8rem] overflow-hidden rounded-none border border-border bg-popover text-popover-foreground shadow-dropdown animate-fade-in",
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          // Only vertical padding: options run edge-to-edge so the highlight
          // surface reaches the panel border (option px-4 keeps the 16px text inset).
          className={cn("py-1", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
})

const SelectItem = React.forwardRef(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        // 44px rows (py-3 + 20px caption line) with a square, edge-to-edge hover
        // surface — matches the OCELIA `Selection/Single/Option` mockup. px-4 both
        // sides now that the right-hand checkmark is gone.
        "flex w-full cursor-pointer select-none items-center rounded-none px-4 py-3 text-caption outline-none",
        // The currently-selected option reads bold (no checkmark) when the menu is
        // reopened — Radix flags it data-state=checked, and the attribute selector
        // outweighs text-caption's own font-weight.
        "data-[state=checked]:font-semibold",
        // Hover / keyboard-highlight surface = #F2E8FF (primary-subtle). Radix flags
        // the active option with `data-highlighted` AND moves DOM focus to it, so
        // pointer-hover and arrow-key navigation both tint the same row.
        "focus:bg-primary-subtle data-[highlighted]:bg-primary-subtle data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
})

const SelectLabel = React.forwardRef(function SelectLabel({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn("px-2 py-1.5 text-caption font-semibold text-muted-foreground", className)}
      {...props}
    />
  )
})

const SelectSeparator = React.forwardRef(function SelectSeparator({ className, ...props }, ref) {
  return <SelectPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
})

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
}
