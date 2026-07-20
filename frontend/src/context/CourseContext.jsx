import { createContext, useContext, useMemo, useState } from "react"
import { useLocation } from "react-router-dom"

const CourseContext = createContext(null)

/**
 * Parse the active course/module IDs out of the URL path. The URL is the single
 * source of truth for these IDs (deep-linkable, refresh-safe) — they are NOT
 * held in component state, which was the legacy `App.jsx` bug that blanked the
 * screen on refresh / direct links.
 *
 * Handles `/courses/:courseId`, `/courses/:courseId/modules/:moduleId`,
 * `/instructor/courses/:courseId/...` (incl. `modules/new` and `modules/:id/edit`),
 * and `/admin/courses/:courseId`.
 *
 * @param {string} pathname
 * @returns {{ courseId: string|null, moduleId: string|null }}
 */
export function extractIds(pathname) {
  const parts = (pathname || "").split("/").filter(Boolean)
  let courseId = null
  let moduleId = null

  const ci = parts.indexOf("courses")
  if (ci !== -1 && parts[ci + 1]) courseId = decodeURIComponent(parts[ci + 1])

  const mi = parts.indexOf("modules")
  if (mi !== -1 && parts[mi + 1] && parts[mi + 1] !== "new") {
    moduleId = decodeURIComponent(parts[mi + 1])
  }

  return { courseId, moduleId }
}

/**
 * Active course/module context (one of the three OCELIA contexts). IDs are
 * derived from the URL; the resolved `course` / `module` objects are populated
 * by the Phase 3 data layer (TanStack Query) and stay null here.
 *
 * Must render inside a Router (it reads the location).
 */
export function CourseProvider({ children }) {
  const { pathname } = useLocation()
  const [course, setCourse] = useState(null)
  const [module, setModule] = useState(null)

  const value = useMemo(() => {
    const { courseId, moduleId } = extractIds(pathname)
    return { courseId, moduleId, course, module, setCourse, setModule }
  }, [pathname, course, module])

  return <CourseContext.Provider value={value}>{children}</CourseContext.Provider>
}

export function useCourse() {
  const ctx = useContext(CourseContext)
  if (!ctx) {
    throw new Error("useCourse must be used within a CourseProvider")
  }
  return ctx
}
