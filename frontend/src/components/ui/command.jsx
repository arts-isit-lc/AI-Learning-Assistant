import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { MdSearch } from "react-icons/md"
import { Icon } from "./icon"
import { cn } from "@/lib/utils"

const Command = React.forwardRef(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
})

const CommandInput = React.forwardRef(function CommandInput({ className, ...props }, ref) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Icon icon={MdSearch} size={18} className="shrink-0 opacity-60" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          "flex h-10 w-full bg-transparent py-3 text-caption outline-none placeholder:text-muted-foreground disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
})

const CommandList = React.forwardRef(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn("max-h-72 overflow-y-auto overflow-x-hidden p-1", className)}
      {...props}
    />
  )
})

const CommandEmpty = React.forwardRef(function CommandEmpty(props, ref) {
  return (
    <CommandPrimitive.Empty ref={ref} className="py-6 text-center text-caption text-muted-foreground" {...props} />
  )
})

const CommandGroup = React.forwardRef(function CommandGroup({ className, ...props }, ref) {
  return <CommandPrimitive.Group ref={ref} className={cn("overflow-hidden p-1 text-foreground", className)} {...props} />
})

const CommandItem = React.forwardRef(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-caption outline-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className
      )}
      {...props}
    />
  )
})

const CommandSeparator = React.forwardRef(function CommandSeparator({ className, ...props }, ref) {
  return <CommandPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
})

export { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator }
