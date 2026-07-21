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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive",
        className
      )}
      {...props}
    />
  )
})

export { Input }
