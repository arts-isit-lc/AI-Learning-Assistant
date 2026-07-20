import { describe, it, expect, vi, beforeEach } from "vitest"

const notifyUnauthorized = vi.fn()
const fetchAuthSession = vi.fn()
vi.mock("./authBridge", () => ({ notifyUnauthorized: () => notifyUnauthorized() }))
vi.mock("aws-amplify/auth", () => ({ fetchAuthSession: (...a) => fetchAuthSession(...a) }))
// http.js imports apiClient but withAuth takes the call directly, so a stub is fine.
vi.mock("./api", () => ({ default: {} }))

import { withAuth, parseWith } from "./http"
import { CoursesSchema } from "./schemas/student"

const err = (status) => Object.assign(new Error("e"), { status })

beforeEach(() => {
  notifyUnauthorized.mockReset()
  fetchAuthSession.mockReset()
})

describe("withAuth interceptor", () => {
  it("passes a successful call through", async () => {
    await expect(withAuth(() => Promise.resolve("ok"))).resolves.toBe("ok")
  })

  it("refreshes the token and retries once on 401, then succeeds", async () => {
    fetchAuthSession.mockResolvedValue({})
    const call = vi.fn().mockRejectedValueOnce(err(401)).mockResolvedValueOnce("ok")
    await expect(withAuth(call)).resolves.toBe("ok")
    expect(fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: true })
    expect(call).toHaveBeenCalledTimes(2)
    expect(notifyUnauthorized).not.toHaveBeenCalled()
  })

  it("clears auth when the retry still 401s", async () => {
    fetchAuthSession.mockResolvedValue({})
    const call = vi.fn().mockRejectedValue(err(401))
    await expect(withAuth(call)).rejects.toMatchObject({ status: 401, inline: true })
    expect(notifyUnauthorized).toHaveBeenCalledTimes(1)
  })

  it("clears auth when the refresh itself fails (no retry)", async () => {
    fetchAuthSession.mockRejectedValue(new Error("no refresh"))
    const call = vi.fn().mockRejectedValue(err(401))
    await expect(withAuth(call)).rejects.toMatchObject({ status: 401, inline: true })
    expect(notifyUnauthorized).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("marks 403 inline and never refreshes or retries", async () => {
    const call = vi.fn().mockRejectedValue(err(403))
    await expect(withAuth(call)).rejects.toMatchObject({ status: 403, inline: true })
    expect(call).toHaveBeenCalledTimes(1)
    expect(fetchAuthSession).not.toHaveBeenCalled()
  })

  it("normalizes other errors (500) as non-inline for a toast", async () => {
    const call = vi.fn().mockRejectedValue(err(500))
    await expect(withAuth(call)).rejects.toMatchObject({ status: 500, inline: false })
  })
})

describe("parseWith contract validation", () => {
  it("accepts a valid response and keeps extra backend fields (passthrough)", () => {
    const data = [
      {
        course_id: "c1",
        course_department: "geog",
        course_number: "250",
        course_name: "Intro",
        extra: true,
      },
    ]
    const parsed = parseWith(CoursesSchema, data, "courses")
    expect(parsed[0].course_id).toBe("c1")
    expect(parsed[0].extra).toBe(true)
  })

  it("throws on contract drift in dev", () => {
    expect(() => parseWith(CoursesSchema, [{ course_id: 123 }], "courses")).toThrow()
  })
})
