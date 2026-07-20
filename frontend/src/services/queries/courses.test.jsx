import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mockGet = vi.fn()
vi.mock("../http", () => ({
  http: {
    get: (...a) => mockGet(...a),
    getAuth: () => Promise.resolve({ email: "e@x.com" }),
  },
  // Identity parse — schema behavior is covered in http.test.js.
  parseWith: (_schema, data) => data,
}))

import { useCourses, useCoursePage } from "./courses"

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    // Swallow query errors at the cache level so an expected error case doesn't
    // register as an unhandled rejection in the test runner.
    queryCache: new QueryCache({ onError: () => {} }),
  })
  return function Wrapper({ children }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => mockGet.mockReset())

describe("useCourses", () => {
  it("fetches the student course list", async () => {
    mockGet.mockResolvedValue([{ course_id: "c1" }])
    const { result } = renderHook(() => useCourses(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGet).toHaveBeenCalledWith("student/course", { email: "e@x.com" })
    expect(result.current.data).toHaveLength(1)
  })

  it("uses the instructor-as-student endpoint when asInstructor is set", async () => {
    mockGet.mockResolvedValue([])
    const { result } = renderHook(() => useCourses({ asInstructor: true }), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(mockGet).toHaveBeenCalledWith("instructor/student_course", { email: "e@x.com" })
  })

  // Error/normalization behavior is covered where it's implemented — the http
  // wrapper (http.test.js: 401 refresh, 403 inline, 500 toast) and the
  // QueryClient retry policy (queryClient.test.js). Hooks just pass RQ's result
  // through, so we don't re-test rejection here.
})

describe("useCoursePage", () => {
  it("is disabled (no fetch) without a courseId", () => {
    const { result } = renderHook(() => useCoursePage(undefined), { wrapper: makeWrapper() })
    expect(result.current.fetchStatus).toBe("idle")
    expect(mockGet).not.toHaveBeenCalled()
  })
})
