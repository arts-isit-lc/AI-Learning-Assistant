import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Generic data table: TanStack Table core + the `Table` primitive. Handles
 * loading (skeleton rows) and empty states. Sorting/filtering/virtualization
 * are layered on by callers as needed.
 *
 * @param {{ columns: Array, data?: Array, loading?: boolean, emptyMessage?: string }} props
 */
export function DataTable({ columns, data = [], loading = false, emptyMessage = "No data to display." }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() })
  const colCount = columns.length

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {loading ? (
          Array.from({ length: 3 }, (_, i) => (
            <TableRow key={`sk-${i}`}>
              {Array.from({ length: colCount }, (_, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : table.getRowModel().rows.length ? (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-state={row.getIsSelected() ? "selected" : undefined}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}
