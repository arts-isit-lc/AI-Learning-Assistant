import { describe, it, expect } from "vitest"
import { createQueryClient } from "./queryClient"

describe("createQueryClient", () => {
  it("retries GET queries up to twice, but never a 4xx", () => {
    const retry = createQueryClient().getDefaultOptions().queries.retry
    expect(retry(0, { status: 500 })).toBe(true)
    expect(retry(1, { status: 500 })).toBe(true)
    expect(retry(2, { status: 500 })).toBe(false)
    expect(retry(0, { status: 404 })).toBe(false)
    expect(retry(0, { status: 403 })).toBe(false)
    // network errors have no status → still retried
    expect(retry(0, {})).toBe(true)
  })

  it("uses exponential backoff capped at 30s", () => {
    const retryDelay = createQueryClient().getDefaultOptions().queries.retryDelay
    expect(retryDelay(0)).toBe(1000)
    expect(retryDelay(1)).toBe(2000)
    expect(retryDelay(10)).toBe(30000)
  })

  it("does not auto-retry mutations", () => {
    expect(createQueryClient().getDefaultOptions().mutations.retry).toBe(false)
  })
})
