import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Avatar, AvatarFallback } from "./avatar"

describe("Avatar", () => {
  it("shows the fallback when there is no loaded image", () => {
    render(
      <Avatar>
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    )
    expect(screen.getByText("AB")).toBeInTheDocument()
  })
})
