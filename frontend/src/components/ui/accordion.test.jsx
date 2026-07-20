import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "./accordion"

describe("Accordion", () => {
  it("shows the content of the default-open item", () => {
    render(
      <Accordion type="single" defaultValue="item-1" collapsible>
        <AccordionItem value="item-1">
          <AccordionTrigger>Concept 1</AccordionTrigger>
          <AccordionContent>Modules under concept 1</AccordionContent>
        </AccordionItem>
      </Accordion>
    )
    expect(screen.getByRole("button", { name: /Concept 1/ })).toBeInTheDocument()
    expect(screen.getByText("Modules under concept 1")).toBeInTheDocument()
  })
})
