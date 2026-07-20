import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Label } from "./label"
import { Input } from "./input"

describe("Label", () => {
  it("associates with a control via htmlFor", () => {
    render(
      <>
        <Label htmlFor="email">Email address</Label>
        <Input id="email" />
      </>
    )
    expect(screen.getByLabelText("Email address")).toBeInTheDocument()
  })
})
