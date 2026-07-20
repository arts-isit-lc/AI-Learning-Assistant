import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { StudentRow } from "./StudentRow"

describe("StudentRow", () => {
  it("renders the student's name, email, and actions", () => {
    render(
      <StudentRow
        student={{ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" }}
        actions={<button type="button">Remove</button>}
      />
    )
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByText("ada@example.com")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument()
  })
})
