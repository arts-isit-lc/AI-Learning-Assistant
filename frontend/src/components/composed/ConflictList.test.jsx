import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ConflictList } from "./ConflictList"

const report = {
  has_conflicts: true,
  conflicts: [
    {
      type: "HARD_CONTRADICTION",
      prompt_a_source: "system_prompt",
      prompt_b_source: "module_prompt:Vectors",
      explanation: "Clash on summaries.",
      prompt_a_text: "Avoid summaries",
      prompt_b_text: "Always summarize",
    },
  ],
}

describe("ConflictList", () => {
  it("renders nothing when there are no conflicts", () => {
    const { container } = render(<ConflictList report={{ has_conflicts: false }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when the report is null", () => {
    const { container } = render(<ConflictList report={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a severity pill + 'Conflicts with' and expands to the details", async () => {
    const user = userEvent.setup()
    render(<ConflictList report={report} />)
    expect(screen.getByText("HARD CONTRADICTION")).toBeInTheDocument()
    const row = screen.getByRole("button", { name: /Conflicts with: system level prompt/i })
    await user.click(row)
    expect(await screen.findByText("Clash on summaries.")).toBeInTheDocument()
  })

  it("hides low-confidence conflicts behind a toggle", async () => {
    const user = userEvent.setup()
    const lowConf = {
      has_conflicts: true,
      conflicts: [
        {
          type: "BEHAVIORAL_INCOMPATIBILITY",
          severity: "low_confidence_llm",
          prompt_a_source: "system_prompt",
          prompt_b_source: "module_prompt:X",
        },
      ],
    }
    render(<ConflictList report={lowConf} />)
    // Hidden by default; the toggle reveals it.
    expect(screen.queryByText("BEHAVIOURAL INCOMPATIBILITY")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Show 1 low-confidence conflict/i }))
    expect(screen.getByText("BEHAVIOURAL INCOMPATIBILITY")).toBeInTheDocument()
  })
})
