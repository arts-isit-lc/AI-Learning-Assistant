import { Outlet } from "react-router-dom"

/**
 * Master-detail layout (admin + instructor lists): a persistent left list pane
 * and a right detail pane fed by the nested route's `<Outlet>`. Stacks
 * vertically below the tablet floor (md).
 *
 * @param {{ list: React.ReactNode }} props
 */
export function SplitLayout({ list }) {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6 md:flex-row">
      <aside className="w-full shrink-0 md:w-80">{list}</aside>
      <section className="min-w-0 flex-1">
        <Outlet />
      </section>
    </div>
  )
}
