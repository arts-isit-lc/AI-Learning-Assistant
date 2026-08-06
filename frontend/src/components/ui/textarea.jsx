import * as React from "react"
import { cn } from "@/lib/utils"

/** Multi-line text entry (chat input, prompt settings). Same state set as Input. */
const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-20 w-full rounded-none border border-input bg-background px-3 py-2 text-caption text-foreground transition-colors",
        "placeholder:text-muted-foreground",
        // Focus indicator is the border turning brand purple (#6829C2 / primary)
        // AND thickening to 2px when the field is clicked into — no wrapping
        // outline/ring. (border-box keeps the field's outer size stable.)
        "focus:border-2 focus:border-primary focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Invalid stays red even while focused (higher specificity than focus:border-primary).
        "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus:border-destructive",
        className
      )}
      {...props}
    />
  )
})

export { Textarea }
