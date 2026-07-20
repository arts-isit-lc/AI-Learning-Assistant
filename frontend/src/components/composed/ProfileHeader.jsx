import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

function initialsOf(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

/**
 * Profile / detail header (instructor + course detail pages).
 * @param {{ user: { name?: string, email?: string }, subtitle?: string, actions?: React.ReactNode, className?: string }} props
 */
export function ProfileHeader({ user, subtitle, actions, className }) {
  const name = user?.name || user?.email || "Profile"
  return (
    <div className={cn("flex items-center justify-between gap-4 border-b border-border pb-4", className)}>
      <div className="flex items-center gap-4">
        <Avatar className="h-12 w-12">
          <AvatarFallback>{initialsOf(name)}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-0.5">
          <h1 className="text-h4 font-semibold text-navy">{name}</h1>
          {subtitle && <p className="text-caption text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
