import { Navigate, Outlet, useLocation } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"
import LoadingScreen from "../LoadingScreen"

/**
 * Gate for authenticated routes (layout route → renders an `<Outlet>`). While
 * the session resolves it shows a loading screen; unauthenticated visits go to
 * `/login`, preserving the attempted path in location state for a later bounce-back.
 */
export default function RequireAuth() {
  const { isAuthed, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) return <LoadingScreen />
  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <Outlet />
}
