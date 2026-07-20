import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { DataTable } from "./DataTable"

const columns = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "role", header: "Role" },
]

describe("DataTable", () => {
  it("renders headers and rows", () => {
    render(<DataTable columns={columns} data={[{ name: "Ada", role: "Student" }]} />)
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument()
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument()
  })

  it("shows the empty message when there is no data", () => {
    render(<DataTable columns={columns} data={[]} emptyMessage="No students." />)
    expect(screen.getByText("No students.")).toBeInTheDocument()
  })

  it("shows skeleton rows while loading", () => {
    const { container } = render(<DataTable columns={columns} data={[]} loading />)
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0)
  })
})
