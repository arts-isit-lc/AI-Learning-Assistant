import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { PageContainer } from "./PageContainer"

describe("PageContainer", () => {
  it("renders its children", () => {
    render(<PageContainer>Body</PageContainer>)
    expect(screen.getByText("Body")).toBeInTheDocument()
  })
})
