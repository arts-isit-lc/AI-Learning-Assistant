import { Outlet } from "react-router-dom"
import { cn } from "@/lib/utils"

/**
 * Master-detail layout (admin + instructor lists): a persistent left list pane
 * and a right detail pane fed by the nested route's `<Outlet>`. Matches the
 * OCELIA frames — content sits in the 112px page gutter (lg:px-28); the list is
 * ~1/3 (admin ≈ 403px, instructor ≈ 337px per the frames) with a vertical
 * divider before the detail (32px before it, 64px after). Stacks vertically
 * below the lg breakpoint.
 *
 * @param {{ list: React.ReactNode, listWidth?: string }} props `listWidth` is the
 *   Tailwind width applied to the list pane at lg+.
 */
export function SplitLayout({ list, listWidth = "lg:w-[337px]" }) {
  return (
    <div className="flex w-full flex-col gap-6 px-6 py-8 lg:min-h-[calc(100vh-15rem)] lg:flex-row lg:gap-0 lg:px-28">
      <aside className={cn("w-full shrink-0", listWidth)}>{list}</aside>
      <section className="min-w-0 flex-1 lg:ml-8 lg:border-l lg:border-border lg:pl-16">
        <Outlet />
      </section>
    </div>
  )
}
