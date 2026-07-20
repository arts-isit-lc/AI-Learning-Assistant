import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { queryKeys } from "@/services/queryKeys"

// Controllable WebSocket the test drives (open / chunk / done).
class MockWebSocket {
  static last = null
  constructor(url, protocol) {
    this.url = url
    this.protocol = protocol
    this.sent = []
    MockWebSocket.last = this
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const chunk = (c) => ({ type: "data", payload: { data: { onChatChunk: { chunk: c } } } })
const done = (extra) => ({ type: "data", payload: { data: { onChatChunk: { done: true, ...extra } } } })

const getAuth = vi.fn().mockResolvedValue({ email: "e@x.com" })
const postRaw = vi.fn().mockResolvedValue({ ok: false })
const putRaw = vi.fn().mockResolvedValue({ ok: true })
vi.mock("@/services/api", () => ({
  default: {
    getAuth: (...a) => getAuth(...a),
    postRaw: (...a) => postRaw(...a),
    putRaw: (...a) => putRaw(...a),
  },
}))

import { useChatStream } from "./useChatStream"

function makeWrapper() {
  const client = new QueryClient()
  const Wrapper = ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, Wrapper }
}

beforeEach(() => {
  vi.stubEnv("VITE_GRAPHQL_WS_URL", "https://abc.appsync-api.us-east-1.amazonaws.com/graphql")
  vi.stubEnv("VITE_API_KEY", "da2-testkey")
  global.WebSocket = MockWebSocket
  MockWebSocket.last = null
  postRaw.mockResolvedValue({ ok: false })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const session = { session_id: "s1", session_name: "New chat" }
const messagesKey = queryKeys.sessions.messages("s1")

describe("useChatStream", () => {
  it("streams a turn and writes the final message into the messages cache", async () => {
    const { client, Wrapper } = makeWrapper()
    const { result } = renderHook(() => useChatStream({ courseId: "c1", moduleId: "m1" }), {
      wrapper: Wrapper,
    })

    await act(async () => {
      await result.current.runTurn({ session, messageContent: "hi" })
    })

    // optimistic student message appended to the cache
    expect(client.getQueryData(messagesKey)).toEqual([
      expect.objectContaining({ message_content: "hi", student_sent: true }),
    ])

    const ws = MockWebSocket.last
    expect(ws).toBeTruthy()

    act(() => ws.open())
    expect(result.current.isStreaming).toBe(true)

    act(() => ws.emit(chunk("Hello ")))
    act(() => ws.emit(chunk("world")))
    await waitFor(() => expect(result.current.streamingText).toBe("Hello world"))

    act(() => ws.emit(done({ llm_output: "Hello world", session_name: "Greeting" })))

    await waitFor(() => expect(result.current.isStreaming).toBe(false))
    const msgs = client.getQueryData(messagesKey)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({ student_sent: false, message_content: "Hello world" })
    expect(result.current.streamingText).toBe("")
    expect(result.current.isTyping).toBe(false)
  })

  it("surfaces a retry error when the stream terminates with an error", async () => {
    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useChatStream({ courseId: "c1", moduleId: "m1" }), {
      wrapper: Wrapper,
    })

    await act(async () => {
      await result.current.runTurn({ session, messageContent: "hi" })
    })
    const ws = MockWebSocket.last
    act(() => ws.open())
    act(() => ws.emit(done({ error: true })))

    await waitFor(() => expect(result.current.retryError).toBeTruthy())
    expect(result.current.retryError).toMatchObject({ sessionId: "s1", messageContent: "hi" })
    expect(result.current.isStreaming).toBe(false)
  })
})
