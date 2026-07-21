import { Outlet } from "react-router-dom"
import { AppHeader } from "@/components/composed/AppHeader"

export default function StudentLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader userRole="student" />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
