import { Outlet } from "react-router-dom"
import { AppHeader } from "@/components/composed/AppHeader"

export default function StudentLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader userRole="student" />
      {/* overflow-x-clip absorbs the LearningJourneyBar's full-bleed (w-screen)
          break-out so the vw/scrollbar overshoot never adds a horizontal scrollbar.
          `clip` (not `hidden`) creates no scroll container and leaves the sticky
          header + vertical scrolling untouched. */}
      <main className="flex-1 overflow-x-clip">
        <Outlet />
      </main>
    </div>
  )
}
