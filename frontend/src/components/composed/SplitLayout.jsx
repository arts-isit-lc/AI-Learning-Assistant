import { Outlet } from "react-router-dom"

/**
 * Master-detail layout (admin + instructor lists): a persistent left list pane
 * and a right detail pane fed by the nested route's `<Outlet>`. The content
 * column is capped at 1280px (max-w-7xl, centred). The list pane is 1/3 of that
 * column at ≥1280px (≈427px) and shrinks responsively (staying 1/3) down to the
 * lg breakpoint; below lg it stacks above the detail. A vertical divider sits
 * between the two panes at lg+.
 */
export function SplitLayout({ list }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col px-6 lg:min-h-[calc(100vh-15rem)] lg:flex-row lg:gap-0">
      <aside className="w-full shrink-0 lg:w-1/3 mt-8">{list}</aside>
      <section className="min-w-0 flex-1 lg:ml-8 lg:border-l lg:border-border lg:pl-16 mt-8">
        <Outlet />
      </section>
    </div>
  )
}
