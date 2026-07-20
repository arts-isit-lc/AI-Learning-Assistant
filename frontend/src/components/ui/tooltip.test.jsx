import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./tooltip"

describe("Tooltip", () => {
  it("renders its content when open", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>More info</TooltipTrigger>
          <TooltipContent>Helpful hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful hint")
  })
})
