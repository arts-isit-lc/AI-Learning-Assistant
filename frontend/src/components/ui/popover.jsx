import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef(function PopoverContent(
  { className, align = "center", sideOffset = 10, ...props },
  ref
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-dropdown w-72 rounded-none border border-border bg-popover p-4 text-popover-foreground shadow-dropdown animate-fade-in",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
