import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"

export function initialsOf(name) {
  const trimmed = (name || "").trim()
  // Instructor names arrive "Lastname, Firstname" (app-wide convention). Build
  // the initials in first+last order (e.g. "Lam, Vincent" → "VL") to match the
  // master-list avatars — not the display order, which would give "LV".
  if (trimmed.includes(",")) {
    const [last, first] = trimmed.split(",").map((s) => s.trim())
    return (((first?.[0] ?? "") + (last?.[0] ?? "")).toUpperCase() || "?")
  }
  return (
    trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  )
}

/**
 * Profile / detail header (instructor + course detail pages).
 * @param {{ user: { name?: string, email?: string }, subtitle?: string, actions?: React.ReactNode, className?: string }} props
 */
export function ProfileHeader({ user, subtitle, actions, className }) {
  const name = user?.name || user?.email || "Profile"
  return (
    <div className={cn("flex items-center justify-between gap-4 border-b border-border pb-6", className)}>
      <div className="flex items-center gap-4">
        <Avatar className="h-12 w-12">
          {/* Branded initials avatar (matches the master-list rows), not the
              muted AvatarFallback default. */}
          <AvatarFallback className="bg-primary text-primary-foreground">
            {initialsOf(name)}
          </AvatarFallback>
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
