import { Outlet } from "react-router-dom"
import { AppHeader } from "@/components/composed/AppHeader"
import { InstructorTabBar } from "@/components/composed/InstructorTabBar"

/**
 * Instructor shell: the top banner (brand + account) followed by the
 * `InstructorTabBar` (Courses / Global Analytics / Global Chats). Matches the
 * `Header` + `Header/Instructor` frame split — nav is the tab bar, not the
 * banner.
 */
export default function InstructorLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader role="instructor" />
      <InstructorTabBar />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
