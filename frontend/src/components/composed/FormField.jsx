import { cloneElement, isValidElement, useId } from "react"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

/**
 * Label + control + inline error/hint wrapper for RHF + Zod forms. Field errors
 * render inline here — never as a toast. Clones the child control to wire
 * `id` / `aria-invalid` / `aria-describedby` for accessibility.
 *
 * @param {{ label?: string, error?: string, hint?: string, required?: boolean, children: React.ReactNode, className?: string }} props
 */
export function FormField({ label, error, hint, required, children, className }) {
  const generatedId = useId()
  const controlId = (isValidElement(children) && children.props.id) || generatedId
  const errorId = `${controlId}-error`
  const hintId = `${controlId}-hint`

  const describedBy = cn(error && errorId, hint && !error && hintId) || undefined

  const control = isValidElement(children)
    ? cloneElement(children, {
        id: controlId,
        "aria-invalid": error ? "true" : undefined,
        "aria-describedby": describedBy,
      })
    : children

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <Label htmlFor={controlId}>
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
      )}
      {control}
      {hint && !error && (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
