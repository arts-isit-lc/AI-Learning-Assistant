import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"

// Recharts renders real SVG via layout measurement (ResizeObserver) that jsdom
// can't drive, so we stub the primitives and assert AnalyticsChart composes them
// + exposes the accessible wrapper. (Chart visuals are verified manually / e2e.)
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }) => <div data-testid="rc-responsive">{children}</div>,
  LineChart: ({ children }) => <div data-testid="rc-linechart">{children}</div>,
  Line: () => <div data-testid="rc-line" />,
  XAxis: () => <div data-testid="rc-xaxis" />,
  YAxis: () => <div data-testid="rc-yaxis" />,
  CartesianGrid: () => <div data-testid="rc-grid" />,
  Tooltip: () => <div data-testid="rc-tooltip" />,
}))

import { AnalyticsChart } from "./AnalyticsChart"

describe("AnalyticsChart", () => {
  it("exposes an accessible image role with the provided label", () => {
    render(<AnalyticsChart data={[{ module: "A", Messages: 3 }]} ariaLabel="Messages per module" />)
    expect(screen.getByRole("img", { name: "Messages per module" })).toBeInTheDocument()
  })

  it("composes a line chart", () => {
    render(<AnalyticsChart data={[{ module: "A", Messages: 3 }]} xKey="module" yKey="Messages" />)
    expect(screen.getByTestId("rc-linechart")).toBeInTheDocument()
    expect(screen.getByTestId("rc-line")).toBeInTheDocument()
  })
})
