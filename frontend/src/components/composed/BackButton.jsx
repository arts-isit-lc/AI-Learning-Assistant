import { MdArrowBack } from "react-icons/md"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"

/** Standardised back navigation. */
export function BackButton({ onClick, children = "Back", className }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className={cn("gap-1 pl-2", className)}>
      <Icon icon={MdArrowBack} size={18} />
      {children}
    </Button>
  )
}
