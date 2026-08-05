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
        // Border turns brand purple (#6829C2 / primary) on focus — i.e. when the
        // field is clicked into — while the ring stays keyboard-only (focus-visible).
        "focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Invalid stays red even while focused (higher specificity than focus:border-primary).
        "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus:border-destructive aria-[invalid=true]:focus-visible:ring-destructive",
        className
      )}
      {...props}
    />
  )
})

export { Input }
