import { describe, it, expect, vi } from "vitest"
import { recordSessionStart } from "./sessionAnalytics"

// Don't load the real api client (which pulls in aws-amplify) — every test
// injects its own mock client, so the module-level default is never exercised.
vi.mock("./api", () => ({ default: { post: vi.fn(() => Promise.resolve()) } }))

const FLAG = "aila:session_start_logged"

/** Minimal in-memory Storage stand-in (getItem/setItem is all we use). */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((k) => (map.has(k) ? map.get(k) : null)),
    setItem: vi.fn((k, v) => map.set(k, String(v))),
  }
}

function makeClient(postImpl) {
  return { post: vi.fn(postImpl ?? (() => Promise.resolve({}))) }
}

describe("recordSessionStart", () => {
  it("fires POST student/session_start once, with no params", () => {
    const client = makeClient()
    recordSessionStart({ client, storage: makeStorage() })
    expect(client.post).toHaveBeenCalledTimes(1)
    expect(client.post).toHaveBeenCalledWith("student/session_start")
  })

  it("fires at most once per browser session (dedupes repeat calls)", () => {
    const client = makeClient()
    const storage = makeStorage()
    recordSessionStart({ client, storage })
    recordSessionStart({ client, storage })
    recordSessionStart({ client, storage })
    expect(client.post).toHaveBeenCalledTimes(1)
  })

  it("skips when the session flag is already set (returning within the tab)", () => {
    const client = makeClient()
    recordSessionStart({ client, storage: makeStorage({ [FLAG]: "1" }) })
    expect(client.post).not.toHaveBeenCalled()
  })

  it("sets the dedupe flag before firing, so a rejected POST does not re-fire", () => {
    const client = makeClient(() => Promise.reject(new Error("network")))
    const storage = makeStorage()
    recordSessionStart({ client, storage })
    expect(storage.getItem(FLAG)).toBe("1")
    recordSessionStart({ client, storage })
    expect(client.post).toHaveBeenCalledTimes(1)
  })

  it("never throws when the POST rejects (best-effort)", () => {
    const client = makeClient(() => Promise.reject(new Error("boom")))
    expect(() => recordSessionStart({ client, storage: makeStorage() })).not.toThrow()
  })

  it("never throws and does not fire when storage is unavailable", () => {
    const client = makeClient()
    expect(() => recordSessionStart({ client, storage: null })).not.toThrow()
    expect(client.post).not.toHaveBeenCalled()
  })

  it("does not fire when storage access throws (private mode / blocked)", () => {
    const client = makeClient()
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: vi.fn(),
    }
    expect(() => recordSessionStart({ client, storage })).not.toThrow()
    expect(client.post).not.toHaveBeenCalled()
  })
})
