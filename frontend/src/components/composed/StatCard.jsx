import { cn } from "@/lib/utils"
import { Card, CardContent } from "@/components/ui/card"

/** Single metric card for analytics dashboards. */
export function StatCard({ label, value, trend, className }) {
  return (
    <Card className={cn("", className)}>
      <CardContent className="flex flex-col gap-1 p-6">
        <span className="text-caption text-muted-foreground">{label}</span>
        <span className="text-h2 font-semibold text-navy">{value}</span>
        {trend && <span className="text-caption text-muted-foreground">{trend}</span>}
      </CardContent>
    </Card>
  )
}
