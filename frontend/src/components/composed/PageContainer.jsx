import { cn } from "@/lib/utils"

/** Max-width page wrapper with consistent horizontal padding. */
export function PageContainer({ className, children, ...props }) {
  return (
    <div className={cn("mx-auto w-full max-w-7xl py-6", className)} {...props}>
      {children}
    </div>
  )
}
