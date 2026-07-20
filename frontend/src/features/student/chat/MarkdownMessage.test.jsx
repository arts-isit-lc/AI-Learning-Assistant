import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MarkdownMessage, escapeCurrencyDollars } from "./MarkdownMessage"

describe("escapeCurrencyDollars", () => {
  it("escapes currency-style dollars so they don't become math", () => {
    expect(escapeCurrencyDollars("It costs $18 versus $42.")).toBe(
      "It costs \\$18 versus \\$42."
    )
  })

  it("leaves real inline/display math untouched", () => {
    expect(escapeCurrencyDollars("The value $x$ and $$y=1$$")).toBe(
      "The value $x$ and $$y=1$$"
    )
  })

  it("does not touch dollars inside code fences", () => {
    const input = "```sh\necho $1\n```"
    expect(escapeCurrencyDollars(input)).toBe(input)
  })

  it("is a no-op when there is no dollar sign", () => {
    expect(escapeCurrencyDollars("plain text")).toBe("plain text")
  })
})

describe("MarkdownMessage", () => {
  it("renders markdown emphasis", () => {
    render(<MarkdownMessage content="Hello **world**" />)
    expect(screen.getByText("world").tagName).toBe("STRONG")
  })
})
