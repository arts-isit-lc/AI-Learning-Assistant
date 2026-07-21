import { useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { MdInsights } from "react-icons/md"
import { useAnalytics } from "@/services/queries"
import { titleCase } from "@/utils/formatters"
import { cn } from "@/lib/utils"
import { AnalyticsChart } from "@/components/composed/AnalyticsChart"
import { EmptyState } from "@/components/composed/EmptyState"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"

/**
 * The three metric views behind the Figma chips (376:2182). Each maps to a field
 * the `instructor/analytics` rows already carry, so all three are backed by real
 * data — the chip label is the instructor-facing framing, the axis/summary name
 * the concrete measure. (Student Engagement = module views; Content Metrics =
 * mastery / perfect-score rate.)
 */
const METRICS = [
  { id: "messages", label: "Messages", key: "message_count", title: "Number of messages per module", noun: "message" },
  { id: "engagement", label: "Student Engagement", key: "access_count", title: "Number of views per module", noun: "view" },
  { id: "content", label: "Content Metrics", key: "perfect_score_percentage", title: "Average mastery per module", noun: "%" },
]

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`

/** One data-derived sentence for the selected metric (replaces the mockup lorem ipsum). */
function buildSummary(metric, rows) {
  if (rows.length === 0) return "No activity to summarize yet."
  const n = rows.length
  const top = [...rows].sort((a, b) => Number(b[metric.key] ?? 0) - Number(a[metric.key] ?? 0))[0]
  const topName = titleCase(top?.module_name ?? "")
  const modules = plural(n, "module")

  if (metric.id === "content") {
    const scored = rows.filter((r) => r.perfect_score_percentage != null)
    const avg = scored.length
      ? scored.reduce((s, r) => s + r.perfect_score_percentage, 0) / scored.length
      : null
    return `Average mastery is ${avg == null ? "—" : `${avg.toFixed(1)}%`} across ${modules}. ${topName} has the highest mastery.`
  }

  const total = rows.reduce((s, r) => s + (Number(r[metric.key]) || 0), 0)
  const verb = metric.id === "messages" ? "exchanged" : "recorded"
  return `Students have ${verb} ${plural(total, metric.noun)} across ${modules}. ${topName} has seen the most activity.`
}

/** Escape a CSV cell (quote when it contains a comma, quote, or newline). */
function csvCell(value) {
  const s = String(value ?? "")
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Serialize the analytics rows to CSV (exported for unit testing). */
export function analyticsToCsv(rows) {
  const header = ["Module", "Messages", "Views", "Mastery %"]
  const body = rows.map((r) => [
    r.module_name ?? "",
    r.message_count ?? 0,
    r.access_count ?? 0,
    r.perfect_score_percentage ?? "",
  ])
  return [header, ...body].map((cols) => cols.map(csvCell).join(",")).join("\n")
}

/**
 * Insights tab — Figma 376:2182. A single-series line chart (title below), a
 * metric-switcher chip row (Messages / Student Engagement / Content Metrics), a
 * data-derived Summary, and a footer (Clear data · Export). All three metrics
 * come from the `instructor/analytics` rows. Export downloads a CSV client-side;
 * "Clear data" has no backend yet, so it renders disabled (flagged) rather than
 * pretending to work.
 */
export function InsightsTab() {
  const { courseId } = useParams()
  const { data: rows = [], isLoading, isError } = useAnalytics(courseId)
  const [metricId, setMetricId] = useState("messages")
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0]

  const chartData = useMemo(
    () => rows.map((r) => ({ module: titleCase(r.module_name), value: Number(r[metric.key] ?? 0) })),
    [rows, metric]
  )
  const summary = useMemo(() => buildSummary(metric, rows), [metric, rows])

  const handleExport = () => {
    const csv = analyticsToCsv(rows)
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `analytics-${courseId}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-24 w-full" />
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
      <div>
        <AnalyticsChart data={chartData} xKey="module" yKey="value" ariaLabel={metric.title} />
        <p className="mt-2 text-caption text-foreground">{metric.title}</p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Metric">
        {METRICS.map((m) => {
          const active = m.id === metricId
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={active}
              onClick={() => setMetricId(m.id)}
              className={cn(
                "rounded-full border border-primary px-4 py-1 text-caption font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent text-primary hover:bg-primary-subtle"
              )}
            >
              {m.label}
            </button>
          )
        })}
      </div>

      <div>
        <h3 className="text-caption font-semibold text-neutral-900">Summary</h3>
        <p className="mt-2 text-foreground">{summary}</p>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <button
          type="button"
          disabled
          title="Clearing analytics data isn't available yet"
          className="cursor-not-allowed text-caption font-semibold text-destructive opacity-50"
        >
          Clear data
        </button>
        <Button variant="ghost" onClick={handleExport}>
          Export
        </Button>
      </div>
    </div>
  )
}
