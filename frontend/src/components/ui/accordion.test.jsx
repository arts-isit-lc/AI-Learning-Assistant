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

  it("keeps the top gap inside the animated box (inner padding, no outer margin) so the slide stays smooth", () => {
    render(
      <Accordion type="single" defaultValue="item-1" collapsible>
        <AccordionItem value="item-1">
          <AccordionTrigger>Concept 1</AccordionTrigger>
          <AccordionContent>Modules under concept 1</AccordionContent>
        </AccordionItem>
      </Accordion>
    )
    // Spacing is padding on the inner element — clipped by overflow-hidden and
    // part of the height keyframe, so it animates.
    const inner = screen.getByText("Modules under concept 1")
    expect(inner).toHaveClass("pt-4", "pb-4")
    // The animated wrapper must carry no outer vertical margin (a margin isn't
    // clipped/animated and would snap in/out).
    const animated = inner.parentElement
    expect(animated).toHaveClass("overflow-hidden", "data-[state=open]:animate-accordion-down")
    expect(animated.className).not.toMatch(/(^|\s)mt-/)
  })

  it("greys the disclosure chevron while the trigger is hovered (group-hover:text-neutral-400)", () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="item-1">
          <AccordionTrigger>Concept 1</AccordionTrigger>
          <AccordionContent>Body</AccordionContent>
        </AccordionItem>
      </Accordion>
    )
    const trigger = screen.getByRole("button", { name: /Concept 1/ })
    expect(trigger).toHaveClass("group")
    expect(trigger.querySelector("svg")).toHaveClass("group-hover:text-neutral-400")
  })
})
