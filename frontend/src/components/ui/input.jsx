import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * Single-line text input. States from tokens: default / focus-visible / disabled
 * / error (drive the error state with `aria-invalid`).
 */
const Input = React.forwardRef(function Input({ className, type = "text", ...props }, ref) {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-10 w-full rounded-none border border-input bg-background px-3 py-2 text-caption text-foreground transition-colors",
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

export { Input }
