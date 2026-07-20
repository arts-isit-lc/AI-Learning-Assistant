import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

class MockWebSocket {
  constructor(url, protocol) {
    this.url = url
    this.protocol = protocol
    this.readyState = 1
    this.sent = []
    MockWebSocket.instances.push(this)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
}
MockWebSocket.instances = []

import { useJobNotification } from "./useJobNotification"

beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal("WebSocket", MockWebSocket)
  vi.stubEnv("VITE_GRAPHQL_WS_URL", "https://abc.appsync-api.us-east-1.amazonaws.com/graphql")
  vi.stubEnv("VITE_API_KEY", "test-key")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("useJobNotification", () => {
  it("resolves on start_ack and fires onNotify on the notification", async () => {
    const { result } = renderHook(() => useJobNotification())
    const onNotify = vi.fn()
    let resolved = false

    act(() => {
      result.current.subscribe("req-1", { onNotify }).then(() => {
        resolved = true
      })
    })

    const ws = MockWebSocket.instances.at(-1)
    expect(ws).toBeTruthy()
    act(() => ws.onopen?.())
    // subscribed to OnNotify with the request id
    expect(ws.sent.some((s) => s.includes("OnNotify") && s.includes("req-1"))).toBe(true)

    act(() => ws.onmessage({ data: JSON.stringify({ type: "start_ack" }) }))
    await waitFor(() => expect(resolved).toBe(true))

    act(() =>
      ws.onmessage({
        data: JSON.stringify({ type: "data", payload: { data: { onNotify: { message: "ready" } } } }),
      })
    )
    expect(onNotify).toHaveBeenCalledWith("ready")
  })

  it("rejects when realtime is not configured", async () => {
    vi.stubEnv("VITE_GRAPHQL_WS_URL", "")
    const { result } = renderHook(() => useJobNotification())
    await expect(result.current.subscribe("req-2", { onNotify: vi.fn() })).rejects.toThrow()
  })
})
