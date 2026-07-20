import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./card"

describe("Card", () => {
  it("renders its header, title, description, and content", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>GEOG 250</CardTitle>
          <CardDescription>Introductory geography</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>
    )
    expect(screen.getByRole("heading", { name: "GEOG 250" })).toBeInTheDocument()
    expect(screen.getByText("Introductory geography")).toBeInTheDocument()
    expect(screen.getByText("Body")).toBeInTheDocument()
  })
})
