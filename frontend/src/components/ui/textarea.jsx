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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive",
        className
      )}
      {...props}
    />
  )
})

export { Textarea }
