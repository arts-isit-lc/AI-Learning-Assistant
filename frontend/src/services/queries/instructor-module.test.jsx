import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"

const mockPost = vi.fn()
const mockPut = vi.fn()
vi.mock("../http", () => ({
  http: {
    post: (...a) => mockPost(...a),
    put: (...a) => mockPut(...a),
    getAuth: () => Promise.resolve({ email: "e@x.com" }),
  },
  parseWith: (_schema, data) => data,
}))

import { useFinalizeModule } from "./instructor-module"

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    queryCache: new QueryCache({ onError: () => {} }),
  })
  return function Wrapper({ children }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const baseVars = {
  moduleId: "m1",
  conceptId: "con1",
  moduleName: "Vectors",
  moduleNumber: 1,
  modulePrompt: "",
  keyTopics: [],
  referencedFileIds: [],
}

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ module_id: "m1" })
  mockPut.mockReset().mockResolvedValue({})
})

describe("useFinalizeModule", () => {
  it("finalizes, saves references, then persists each file description via update_metadata", async () => {
    const { result } = renderHook(() => useFinalizeModule("c1"), { wrapper: makeWrapper() })
    result.current.mutate({
      ...baseVars,
      referencedFileIds: ["ref1"],
      fileDescriptions: [{ fileName: "notes.pdf", description: "Core reading" }],
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPost).toHaveBeenCalledWith(
      "instructor/finalize_module",
      expect.objectContaining({ module_id: "m1", course_id: "c1" }),
      expect.objectContaining({ module_prompt: "" })
    )
    expect(mockPut).toHaveBeenCalledWith(
      "instructor/module_file_references",
      { module_id: "m1" },
      { referenced_file_ids: ["ref1"] }
    )
    // Description is merged into the file's metadata via update_metadata.
    expect(mockPut).toHaveBeenCalledWith(
      "instructor/update_metadata",
      expect.objectContaining({ module_id: "m1", filename: expect.any(String), filetype: expect.any(String) }),
      { metadata: "Core reading" }
    )
  })

  it("does not call update_metadata when no descriptions are provided", async () => {
    const { result } = renderHook(() => useFinalizeModule("c1"), { wrapper: makeWrapper() })
    result.current.mutate({ ...baseVars, fileDescriptions: [] })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const metadataCalls = mockPut.mock.calls.filter((c) => c[0] === "instructor/update_metadata")
    expect(metadataCalls).toHaveLength(0)
  })
})
