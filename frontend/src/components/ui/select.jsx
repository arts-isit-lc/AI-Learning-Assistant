import * as React from "react"
import * as SelectPrimitive from "@radix-ui/react-select"
import { MdCheck, MdExpandMore } from "react-icons/md"
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
        "flex h-10 w-full items-center justify-between gap-2 rounded-none border border-input bg-background px-3 py-2 text-caption text-foreground",
        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <Icon icon={MdExpandMore} size={18} className="opacity-60" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
})

const SelectContent = React.forwardRef(function SelectContent(
  { className, children, position = "popper", ...props },
  ref
) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        className={cn(
          "relative z-dropdown max-h-96 min-w-[8rem] overflow-hidden rounded-sm border border-border bg-popover text-popover-foreground shadow-dropdown animate-fade-in",
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          className={cn("p-1", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}
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
        "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-caption outline-none",
        "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-4 w-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon icon={MdCheck} size={16} />
        </SelectPrimitive.ItemIndicator>
      </span>
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
