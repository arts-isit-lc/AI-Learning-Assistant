import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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
  AnalyticsChart: ({ ariaLabel }) => <div data-testid="analytics-chart" aria-label={ariaLabel} />,
}))

import { InsightsTab, analyticsToCsv } from "./InsightsTab"

const ROWS = [
  { module_name: "vectors", message_count: 10, perfect_score_percentage: 80, access_count: 5 },
  { module_name: "matrices", message_count: 4, perfect_score_percentage: 40, access_count: 2 },
]

beforeEach(() => {
  analyticsResult = { data: [], isLoading: false, isError: false }
})

describe("analyticsToCsv", () => {
  it("serializes rows to CSV with a header", () => {
    const csv = analyticsToCsv(ROWS)
    expect(csv.split("\n")[0]).toBe("Module,Messages,Views,Mastery %")
    expect(csv).toContain("vectors,10,5,80")
    expect(csv).toContain("matrices,4,2,40")
  })
})

describe("InsightsTab", () => {
  it("renders the chart, metric chips, and a data-derived summary (Messages default)", () => {
    analyticsResult = { data: ROWS, isLoading: false, isError: false }
    render(<InsightsTab />)

    expect(screen.getByTestId("analytics-chart")).toBeInTheDocument()
    expect(screen.getByText("Number of messages per module")).toBeInTheDocument()
    // metric switcher chips
    expect(screen.getByRole("button", { name: "Messages" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Student Engagement" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Content Metrics" })).toBeInTheDocument()
    // summary derived from the rows (14 total messages, 2 modules, top = Vectors)
    expect(screen.getByText(/14 messages across 2 modules/i)).toBeInTheDocument()
  })

  it("switches the chart title + summary when another metric is selected", async () => {
    analyticsResult = { data: ROWS, isLoading: false, isError: false }
    render(<InsightsTab />)

    await userEvent.click(screen.getByRole("button", { name: "Content Metrics" }))
    expect(screen.getByText("Average mastery per module")).toBeInTheDocument()
    // avg mastery (80 + 40) / 2 = 60.0%
    expect(screen.getByText(/Average mastery is 60\.0%/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Student Engagement" }))
    expect(screen.getByText("Number of views per module")).toBeInTheDocument()
    expect(screen.getByText(/7 views across 2 modules/i)).toBeInTheDocument()
  })

  it("offers Export and a disabled Clear data control", () => {
    analyticsResult = { data: ROWS, isLoading: false, isError: false }
    render(<InsightsTab />)
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Clear data" })).toBeDisabled()
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
