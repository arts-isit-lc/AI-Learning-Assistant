import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Alert, AlertTitle, AlertDescription } from "./alert"

describe("Alert", () => {
  it("exposes the alert role with its content", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Something needs attention.</AlertDescription>
      </Alert>
    )
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Heads up")
    expect(alert).toHaveTextContent("Something needs attention.")
  })
})
