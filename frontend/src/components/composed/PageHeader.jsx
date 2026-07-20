import { cn } from "@/lib/utils"

/** Top-of-page title (+ optional description) with a right-aligned actions slot. */
export function PageHeader({ title, description, actions, className }) {
  return (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="flex flex-col gap-1">
        <h1 className="text-h2 font-semibold text-navy">{title}</h1>
        {description && <p className="text-body text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
