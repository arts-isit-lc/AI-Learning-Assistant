import { MdErrorOutline } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

/**
 * Compact prompt-conflict warning banner — Figma AddModule/Step3/A (node 771:6159):
 * a red strip (error icon + message) shown above a prompt field when a conflict
 * check finds clashes. Follows the Figma spec: 12px text at a 28px line-height,
 * a 14px (gap-3.5) icon gap, an 8px (px-2) inset, and the red-secondary
 * (`bg-destructive-muted`) fill with red text. Deliberately NOT the generic
 * bordered `Alert` callout — this is the tighter modal-spec banner.
 *
 * @param {{ className?: string, children?: React.ReactNode }} props
 */
export function ConflictWarning({ className, children = "There are conflicts. Please resolve below." }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-3.5 bg-destructive-muted px-2 text-xs leading-7 text-destructive",
        className
      )}
    >
      <Icon icon={MdErrorOutline} size={18} />
      {children}
    </div>
  )
}
