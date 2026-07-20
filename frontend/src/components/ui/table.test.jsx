import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table"

describe("Table", () => {
  it("renders a table with a column header and a cell", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Module</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Week 1</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )
    expect(screen.getByRole("table")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Module" })).toBeInTheDocument()
    expect(screen.getByRole("cell", { name: "Week 1" })).toBeInTheDocument()
  })
})
