import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { cn } from "@/lib/utils"

/**
 * Resolve an OCELIA colour token to a concrete colour string for SVG. Recharts
 * sets colours as SVG presentation attributes, where `var()` does NOT resolve —
 * so we read the computed CSS variable (HSL channels) and wrap it in `hsl()`.
 * The fallback is the same brand value, used when the var can't be read (jsdom /
 * server), so this stays token-driven rather than hardcoding an arbitrary colour.
 */
function tokenColor(name, fallback) {
  if (typeof document === "undefined") return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value ? `hsl(${value})` : fallback
}

/**
 * Line chart for the Insights tab (Figma AnalyticsChart), restyled onto the
 * design tokens. Generic single-series line: the caller shapes `data` and names
 * the axes via `xKey`/`yKey`. Exposed as `role="img"` with an `ariaLabel` — the
 * per-module figures are also rendered as text nearby for screen-reader parity.
 *
 * @param {{ data?: Array<object>, xKey?: string, yKey?: string, height?: number,
 *   xTickFormatter?: (v: any) => string, ariaLabel?: string, className?: string }} props
 */
export function AnalyticsChart({
  data = [],
  xKey = "label",
  yKey = "value",
  height = 300,
  xTickFormatter,
  ariaLabel = "Line chart",
  className,
}) {
  const lineColor = tokenColor("--primary", "#6829C2")
  const gridColor = tokenColor("--border", "#BFBFBF")
  const axisColor = tokenColor("--muted-foreground", "#737373")

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className={cn("w-full", className)}
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: 12, fill: axisColor }}
            tickFormatter={xTickFormatter}
            interval="preserveStartEnd"
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: axisColor }} />
          <Tooltip
            contentStyle={{
              borderRadius: "var(--radius-md)",
              border: `1px solid ${gridColor}`,
              fontSize: 12,
            }}
          />
          <Line
            type="monotone"
            dataKey={yKey}
            stroke={lineColor}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 6 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
