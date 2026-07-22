import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

/**
 * On/off toggle (Radix Switch under the hood, role="switch"). Used for course
 * active/inactive, per-instructor OCELIA access, and boolean settings.
 */
const Toggle = React.forwardRef(function Toggle({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // On = success green (#11A26F); Off = neutral-300 light grey (#BFBFBF).
        "data-[state=checked]:bg-success data-[state=unchecked]:bg-neutral-300",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-5 w-5 rounded-full bg-background shadow-card transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
    </SwitchPrimitive.Root>
  )
})

export { Toggle }
