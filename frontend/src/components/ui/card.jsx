import * as React from "react"
import { cn } from "@/lib/utils"

const Card = React.forwardRef(function Card({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-sm border border-border bg-card text-card-foreground",
        className
      )}
      {...props}
    />
  )
})

const CardHeader = React.forwardRef(function CardHeader({ className, ...props }, ref) {
  return <div ref={ref} className={cn("flex flex-col gap-1.5 p-6", className)} {...props} />
})

const CardTitle = React.forwardRef(function CardTitle({ className, ...props }, ref) {
  // Heading content is supplied by consumers via children; the static rule can't
  // see it on this reusable primitive (it always receives content in use).
  // eslint-disable-next-line jsx-a11y/heading-has-content
  return <h3 ref={ref} className={cn("text-h4 font-semibold text-navy", className)} {...props} />
})

const CardDescription = React.forwardRef(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn("text-caption text-muted-foreground", className)} {...props} />
})

const CardContent = React.forwardRef(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
})

const CardFooter = React.forwardRef(function CardFooter({ className, ...props }, ref) {
  return <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
})

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
