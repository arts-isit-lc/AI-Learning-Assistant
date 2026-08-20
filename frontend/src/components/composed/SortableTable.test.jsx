import { describe, it, expect } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import {
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { SortableTable } from "./SortableTable"

const DATA = [
  { name: "Charlie", email: "c@x.com" },
  { name: "Alice", email: "a@x.com" },
  { name: "Bob", email: "b@x.com" },
]

const columns = [
  { id: "name", accessorKey: "name", header: "Name" },
  { accessorKey: "email", header: "Email" },
  {
    id: "action",
    header: "Action",
    enableSorting: false,
    meta: { align: "right" },
    cell: () => <span>go</span>,
  },
]

// Minimal harness: a client-side sorted + paginated table wired to SortableTable,
// exercising the same config shape the Students tab uses.
function Harness({ data = DATA, pageSize = 20 }) {
  const [sorting, setSorting] = useState([{ id: "name", desc: false }])
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    enableSortingRemoval: false,
    columnResizeMode: "onChange",
    enableColumnResizing: true,
    initialState: { pagination: { pageSize } },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })
  return (
    <SortableTable
      table={table}
      page={table.getState().pagination.pageIndex}
      pageCount={table.getPageCount()}
      onPageChange={(p) => table.setPageIndex(p)}
      total={data.length}
      emptyMessage="Nothing here."
    />
  )
}

const dataRowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1) // drop the header row
    .map((r) => within(r).getAllByRole("cell")[0].textContent)

describe("SortableTable", () => {
  it("renders sortable columns as toggle buttons but leaves non-sortable columns as plain headers", () => {
    render(<Harness />)
    expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Email" })).toBeInTheDocument()
    // "Action" opts out of sorting → header is not a button.
    expect(screen.queryByRole("button", { name: "Action" })).not.toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "Action" })).toBeInTheDocument()
  })

  it("reflects the sort state via aria-sort and toggles asc <-> desc on click", async () => {
    render(<Harness />)
    // Default sort is name ascending.
    expect(dataRowNames()).toEqual(["Alice", "Bob", "Charlie"])
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending")

    await userEvent.click(screen.getByRole("button", { name: "Name" }))
    expect(dataRowNames()).toEqual(["Charlie", "Bob", "Alice"])
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "descending")
  })

  it("shows the result count and paginates when rows exceed the page size", async () => {
    render(<Harness pageSize={2} />)
    // Page 1: 2 of 3 rows.
    expect(screen.getByText("Displaying 2 out of 3 results")).toBeInTheDocument()
    expect(dataRowNames()).toEqual(["Alice", "Bob"])

    await userEvent.click(screen.getByRole("button", { name: "Page 2" }))
    expect(screen.getByText("Displaying 1 out of 3 results")).toBeInTheDocument()
    expect(dataRowNames()).toEqual(["Charlie"])
  })

  it("renders the empty message and hides the footer when there are no rows", () => {
    render(<Harness data={[]} />)
    expect(screen.getByText("Nothing here.")).toBeInTheDocument()
    expect(screen.queryByText(/Displaying/)).not.toBeInTheDocument()
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument()
  })
})
