import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { cn } from "@/lib/utils"

const Popover = PopoverPrimitive.Root
const PopoverTrigger = PopoverPrimitive.Trigger
const PopoverAnchor = PopoverPrimitive.Anchor

/**
 * @param {boolean} [portal=true] Render the content in a portal on `<body>`
 *   (the default). Pass `portal={false}` to render it in place — needed when the
 *   popover lives inside a modal `Dialog`, whose `pointer-events: none` on
 *   outside regions would otherwise break option clicks + outside-click dismiss.
 */
const PopoverContent = React.forwardRef(function PopoverContent(
  { className, align = "center", sideOffset = 10, portal = true, ...props },
  ref
) {
  const content = (
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
  )
  return portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content
})

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
