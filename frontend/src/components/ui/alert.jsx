import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * Inline, persistent status callout (distinct from the transient toast). An
 * optional leading `<svg>`/`<Icon>` is positioned automatically.
 */
const alertVariants = cva(
  "relative w-full rounded-lg border p-4 text-caption [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground",
        info: "border-info/40 bg-info/10 text-foreground",
        success: "border-success/40 bg-success/10 text-foreground",
        warning: "border-warning/40 bg-warning/10 text-foreground",
        destructive: "border-destructive/40 bg-destructive-muted text-destructive-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  }
)

const Alert = React.forwardRef(function Alert({ className, variant, ...props }, ref) {
  return <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
})

const AlertTitle = React.forwardRef(function AlertTitle({ className, ...props }, ref) {
  // Heading content is supplied by consumers via children; the static rule can't
  // see it on this reusable primitive (it always receives content in use).
  // eslint-disable-next-line jsx-a11y/heading-has-content
  return <h5 ref={ref} className={cn("mb-1 font-semibold leading-none tracking-tight", className)} {...props} />
})

const AlertDescription = React.forwardRef(function AlertDescription({ className, ...props }, ref) {
  return <div ref={ref} className={cn("text-caption [&_p]:leading-relaxed", className)} {...props} />
})

export { Alert, AlertTitle, AlertDescription, alertVariants }
