import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"

let analyticsResult
vi.mock("@/services/queries", () => ({
  useAnalytics: () => analyticsResult,
}))
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useParams: () => ({ courseId: "c1" }) }
})
// Recharts isn't unit-testable in jsdom; the chart has its own smoke test.
vi.mock("@/components/composed/AnalyticsChart", () => ({
  AnalyticsChart: () => <div data-testid="analytics-chart" />,
}))

import { InsightsTab } from "./InsightsTab"

const ROWS = [
  { module_name: "vectors", message_count: 10, perfect_score_percentage: 80, access_count: 5 },
  { module_name: "matrices", message_count: 4, perfect_score_percentage: 40, access_count: 2 },
]

beforeEach(() => {
  analyticsResult = { data: [], isLoading: false, isError: false }
})

describe("InsightsTab", () => {
  it("renders aggregate stats, the chart, and a per-module breakdown", () => {
    analyticsResult = { data: ROWS, isLoading: false, isError: false }
    render(<InsightsTab />)

    // aggregate stat cards (assert the unambiguous derived values)
    expect(screen.getByText("Modules")).toBeInTheDocument()
    expect(screen.getByText("14")).toBeInTheDocument() // total messages 10 + 4
    expect(screen.getByText("60.0%")).toBeInTheDocument() // avg mastery (80 + 40) / 2

    expect(screen.getByTestId("analytics-chart")).toBeInTheDocument()

    // per-module table (title-cased names + formatted mastery)
    expect(screen.getByText("Vectors")).toBeInTheDocument()
    expect(screen.getByText("Matrices")).toBeInTheDocument()
    expect(screen.getByText("80.0%")).toBeInTheDocument()
  })

  it("shows the empty state when there is no analytics data", () => {
    render(<InsightsTab />)
    expect(screen.getByRole("heading", { name: "No analytics yet" })).toBeInTheDocument()
  })

  it("shows an error alert when analytics fail to load", () => {
    analyticsResult = { data: undefined, isLoading: false, isError: true }
    render(<InsightsTab />)
    expect(screen.getByText("Couldn’t load analytics")).toBeInTheDocument()
  })
})
