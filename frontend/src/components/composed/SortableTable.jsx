import { flexRender } from "@tanstack/react-table"
import { cn } from "@/lib/utils"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { Pagination } from "./Pagination"

/**
 * Stacked up/down sort triangles (Figma 376:2331). Both triangles are faded at
 * rest; the active direction goes solid (`fill-current` inherits the header's
 * white text). Decorative — the column header's `aria-sort` conveys state.
 * @param {{ direction: "asc" | "desc" | false }} props
 */
function SortIndicator({ direction }) {
  return (
    <svg viewBox="0 0 10 14" width="13" height="20" aria-hidden="true" className="shrink-0 fill-current">
      <path d="M5 0 9 5H1z" className={cn(direction === "asc" ? "opacity-100" : "opacity-40")} />
      <path d="M5 14 1 9h8z" className={cn(direction === "desc" ? "opacity-100" : "opacity-40")} />
    </svg>
  )
}

/**
 * Shared OCELIA data-table shell (instructor Chat History + Students tabs). Given
 * a configured TanStack `table` instance it renders: a purple header whose
 * sortable columns toggle asc/desc via a double-triangle indicator, drag-resizable
 * columns sized as a percentage of the parent (so the table always fits its
 * container), zebra-striped rows (#F5F5F5 on odd rows), vertical column dividers,
 * black top-left-aligned cells, and a footer with a result count + numbered
 * pagination.
 *
 * Sorting/pagination are owned by the caller's `table` config, so this works for
 * both client-side (Students) and server-side (Chat History) data. Per-column
 * opt-outs: `enableSorting: false` (plain header, no toggle) and `meta.align:
 * "right"`. Columns that shouldn't resize set `enableResizing: false`.
 *
 * @param {object} props
 * @param {import("@tanstack/react-table").Table<any>} props.table Configured TanStack table.
 * @param {number} props.page Current page (0-indexed) for the footer pagination.
 * @param {number} props.pageCount Total pages.
 * @param {(page: number) => void} props.onPageChange
 * @param {number} props.total Total row count across all pages (for the count label).
 * @param {string} [props.emptyMessage] Row shown when the current page has no rows.
 */
export function SortableTable({ table, page, pageCount, onPageChange, total, emptyMessage = "No data to display." }) {
  const totalSize = table.getCenterTotalSize()
  const pct = (size) => `${(size / totalSize) * 100}%`
  const rows = table.getRowModel().rows
  const colCount = table.getAllLeafColumns().length

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-sm border border-border">
        {/* Always fit the parent (w-full from the primitive). With table-layout
            fixed the per-column sizes act as proportions (via pct), so columns
            shrink to the container width instead of forcing the table wider. */}
        <Table className="[table-layout:fixed]">
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header, i, arr) => {
                  const canSort = header.column.getCanSort()
                  const sorted = header.column.getIsSorted() // "asc" | "desc" | false
                  const meta = header.column.columnDef.meta
                  // Header alignment can be set independently of the cell's
                  // (`headerAlign`), falling back to the shared `align`.
                  const alignRight = (meta?.headerAlign ?? meta?.align) === "right"
                  const label = flexRender(header.column.columnDef.header, header.getContext())
                  return (
                    <TableHead
                      key={header.id}
                      style={{ width: pct(header.getSize()) }}
                      aria-sort={
                        canSort
                          ? sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                          : undefined
                      }
                      className={cn(
                        "relative bg-primary font-semibold text-primary-foreground",
                        // Column separator (translucent white to read on purple).
                        i < arr.length - 1 && "border-r border-primary-foreground/20"
                      )}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "flex w-full items-center gap-2",
                            alignRight ? "justify-end text-right" : "justify-between text-left"
                          )}
                        >
                          <span className="truncate">{label}</span>
                          <SortIndicator direction={sorted} />
                        </button>
                      ) : (
                        <span className={cn("block truncate", alignRight ? "text-right" : "text-left")}>
                          {label}
                        </span>
                      )}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          aria-hidden="true"
                          className={cn(
                            "absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none bg-primary-foreground/20 opacity-0 transition-opacity hover:opacity-100",
                            header.column.getIsResizing() && "bg-primary-foreground/50 opacity-100"
                          )}
                        />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, rowIndex) => (
                // Zebra striping: odd rows (1st, 3rd, …) get the #F5F5F5 muted fill.
                <TableRow key={row.id} className={cn(rowIndex % 2 === 0 && "bg-muted")}>
                  {row.getVisibleCells().map((cell, i, arr) => {
                    const alignRight = cell.column.columnDef.meta?.align === "right"
                    return (
                      <TableCell
                        key={cell.id}
                        style={{ width: pct(cell.column.getSize()) }}
                        className={cn(
                          "align-top text-neutral-900",
                          alignRight ? "text-right" : "text-left",
                          i < arr.length - 1 && "border-r border-border"
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-caption text-muted-foreground">
            Displaying {rows.length} out of {total} results
          </p>
          <Pagination page={page} pageCount={pageCount} onPageChange={onPageChange} />
        </div>
      )}
    </div>
  )
}
