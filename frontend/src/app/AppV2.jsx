import { lazy, Suspense, useState } from "react"
import { BrowserRouter } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"
import { ToastContainer } from "react-toastify"
import "react-toastify/dist/ReactToastify.css"
import ErrorBoundary from "@/components/ErrorBoundary"
import { AuthProvider } from "@/context/AuthContext"
import { NotificationProvider } from "@/context/NotificationContext"
import { CourseProvider } from "@/context/CourseContext"
import { OfflineBanner } from "@/components/composed/OfflineBanner"
import { createQueryClient } from "@/services/queryClient"
import AppRoutes from "./AppRoutes"
import LoadingScreen from "./LoadingScreen"

// Dev-only React Query devtools — dead-code-eliminated from the prod build
// (import.meta.env.DEV is statically false there).
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((m) => ({
        default: m.ReactQueryDevtools,
      }))
    )
  : () => null

function GlobalErrorFallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-h4 font-semibold text-foreground">Something went wrong.</p>
      <p className="text-body text-muted-foreground">
        The page hit an unexpected error. Reloading usually fixes it.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-primary px-4 py-2 text-caption font-semibold text-primary-foreground transition-colors duration-fast hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Reload
      </button>
    </div>
  )
}

/**
 * OCELIA app shell (Phase 2), rendered when `VITE_UI_V2` is enabled. Wires the
 * three global contexts (Auth / Notification / Course), the router, global
 * toasts, and a top-level error boundary. The legacy MUI app stays the default
 * until the rebuild completes (strangler migration; flag removed in Phase 8).
 */
export default function AppV2() {
  // One client per mount (stable across re-renders).
  const [queryClient] = useState(() => createQueryClient())

  return (
    <ErrorBoundary fallbackRender={() => <GlobalErrorFallback />}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <NotificationProvider>
            <BrowserRouter>
              <CourseProvider>
                <OfflineBanner />
                <ToastContainer
                  position="top-center"
                  autoClose={2000}
                  theme="colored"
                  newestOnTop
                />
                <Suspense fallback={<LoadingScreen />}>
                  <AppRoutes />
                </Suspense>
              </CourseProvider>
            </BrowserRouter>
          </NotificationProvider>
        </AuthProvider>
        {import.meta.env.DEV && (
          <Suspense fallback={null}>
            <ReactQueryDevtools initialIsOpen={false} />
          </Suspense>
        )}
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
