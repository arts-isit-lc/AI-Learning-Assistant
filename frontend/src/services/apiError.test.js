import { describe, it, expect } from "vitest"
import { ApiError, toUserMessage } from "./apiError"

describe("toUserMessage", () => {
  it("maps known statuses to friendly copy", () => {
    expect(toUserMessage({ status: 404 })).toBe("We couldn't find that.")
    expect(toUserMessage({ status: 429 })).toMatch(/Too many requests/)
    expect(toUserMessage({ status: 500 })).toMatch(/on our end/)
    expect(toUserMessage({ status: null })).toMatch(/Network problem/)
    expect(toUserMessage({})).toMatch(/Network problem/) // undefined status → null branch
    expect(toUserMessage({ status: 400, message: "Bad input" })).toBe("Bad input")
  })

  it("applies per-status overrides, falling back to the shared default otherwise", () => {
    const overrides = { 400: "Duplicate name.", 409: "Still processing." }
    expect(toUserMessage({ status: 400 }, overrides)).toBe("Duplicate name.")
    expect(toUserMessage({ status: 409 }, overrides)).toBe("Still processing.")
    // a status not in the map falls through to the shared mapping
    expect(toUserMessage({ status: 500 }, overrides)).toMatch(/on our end/)
    expect(toUserMessage({ status: 404 }, overrides)).toBe("We couldn't find that.")
  })
})

describe("ApiError", () => {
  it("carries status + inline and names itself", () => {
    const e = new ApiError("nope", { status: 403, inline: true })
    expect(e.name).toBe("ApiError")
    expect(e.status).toBe(403)
    expect(e.inline).toBe(true)
    expect(e.message).toBe("nope")
  })
})
