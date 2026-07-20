import { useMemo } from "react"
import { useParams } from "react-router-dom"
import { MdInsights } from "react-icons/md"
import { useAnalytics } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { AnalyticsChart } from "@/components/composed/AnalyticsChart"
import { StatCard } from "@/components/composed/StatCard"
import { DataTable } from "@/components/composed/DataTable"
import { EmptyState } from "@/components/composed/EmptyState"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"

const fmtPct = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`)

const COLUMNS = [
  { accessorKey: "module_name", header: "Module", cell: ({ getValue }) => titleCase(getValue()) },
  { accessorKey: "message_count", header: "Messages", cell: ({ getValue }) => getValue() ?? 0 },
  {
    accessorKey: "perfect_score_percentage",
    header: "Mastery",
    cell: ({ getValue }) => fmtPct(getValue()),
  },
  { accessorKey: "access_count", header: "Views", cell: ({ getValue }) => getValue() ?? 0 },
]

/**
 * Insights tab — ports the legacy `instructor/analytics` chart (messages per
 * module) + per-module stats, restyled. The metric switcher, tag filters, Clear
 * data, and Export are intentionally out of scope (B1, deferred).
 */
export function InsightsTab() {
  const { courseId } = useParams()
  const { data: rows = [], isLoading, isError } = useAnalytics(courseId)

  const { chartData, totalMessages, avgMastery } = useMemo(() => {
    const chart = rows.map((r) => ({ module: r.module_name, Messages: r.message_count ?? 0 }))
    const total = rows.reduce((sum, r) => sum + (r.message_count ?? 0), 0)
    const scored = rows.filter((r) => r.perfect_score_percentage != null)
    const avg =
      scored.length > 0
        ? scored.reduce((s, r) => s + r.perfect_score_percentage, 0) / scored.length
        : null
    return { chartData: chart, totalMessages: total, avgMastery: avg }
  }, [rows])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&rsquo;t load analytics</AlertTitle>
        <AlertDescription>Please refresh and try again.</AlertDescription>
      </Alert>
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MdInsights}
        title="No analytics yet"
        description="Analytics appear once students start chatting with this course's modules."
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Modules" value={rows.length} />
        <StatCard label="Total messages" value={totalMessages} />
        <StatCard label="Avg mastery" value={fmtPct(avgMastery)} />
      </div>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-4 text-h4 font-semibold text-navy">Messages per module</h2>
          <AnalyticsChart
            data={chartData}
            xKey="module"
            yKey="Messages"
            xTickFormatter={titleCase}
            ariaLabel="Messages per module"
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-4 text-h4 font-semibold text-navy">Per-module breakdown</h2>
          <DataTable columns={COLUMNS} data={rows} />
        </CardContent>
      </Card>
    </div>
  )
}
