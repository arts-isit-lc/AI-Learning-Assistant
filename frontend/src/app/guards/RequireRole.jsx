import { Navigate, Outlet } from "react-router-dom"
import { useAuth } from "@/context/AuthContext"
import { roleHomePath } from "../roleHome"
import LoadingScreen from "../LoadingScreen"

/**
 * Role guard (layout route → renders an `<Outlet>`). A wrong-role visit is
 * redirected to the visitor's own role home — never a dead end. Client-side
 * only (UX); the backend Cognito authorizers enforce real access.
 *
 * @param {{ allow?: Array<"admin"|"instructor"|"student"> }} props
 */
export default function RequireRole({ allow = [] }) {
  const { role, isLoading, isInstructorAsStudent } = useAuth()

  if (isLoading) return <LoadingScreen />
  if (!role) return <Navigate to="/login" replace />
  if (!allow.includes(role)) {
    return <Navigate to={roleHomePath(role, isInstructorAsStudent)} replace />
  }
  return <Outlet />
}
