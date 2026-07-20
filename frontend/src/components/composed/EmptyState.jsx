import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Placeholder for empty lists / no-results states.
 * @param {{ icon?: React.ComponentType, title: string, description?: string, action?: React.ReactNode, className?: string }} props
 */
export function EmptyState({ icon, title, description, action, className }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-12 text-center",
        className
      )}
    >
      {icon && <Icon icon={icon} size={40} className="text-muted-foreground" />}
      <h3 className="text-h4 font-semibold text-foreground">{title}</h3>
      {description && <p className="max-w-sm text-caption text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
