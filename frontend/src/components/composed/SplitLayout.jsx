import { Outlet } from "react-router-dom"

/**
 * Master-detail layout (admin + instructor lists): a persistent left list pane
 * and a right detail pane fed by the nested route's `<Outlet>`. The content
 * column is capped at 1280px (max-w-7xl, centred). The list pane is a fixed
 * 320px at ≥1280px (xl) and shrinks responsively (1/4 of the column) between the
 * lg and xl breakpoints; below lg it stacks above the detail. A vertical divider
 * sits between the two panes at lg+.
 */
export function SplitLayout({ list }) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 lg:min-h-[calc(100vh-15rem)] lg:flex-row lg:gap-0">
      <aside className="w-full shrink-0 lg:w-1/4 xl:w-80">{list}</aside>
      <section className="min-w-0 flex-1 lg:ml-8 lg:border-l lg:border-border lg:pl-16">
        <Outlet />
      </section>
    </div>
  )
}
