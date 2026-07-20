import { useCallback, useEffect, useRef } from "react"

const NOTIFY_TIMEOUT_MS = 180000

/**
 * Subscribe to an AppSync `onNotify(request_id)` event for a long-running backend
 * job (chat-log export). Ported from the legacy inline WebSocket, modeled on the
 * student `useChatStream` setup (API_KEY auth, graphql-ws protocol).
 *
 * `subscribe(requestId, { onNotify })` opens the socket and RESOLVES its promise
 * once the subscription is confirmed (`start_ack`) — so the caller can POST the
 * job only after the subscription is live and can't miss the notification. When
 * the notification arrives, `onNotify(message)` fires and the socket closes.
 */
export function useJobNotification() {
  const wsRef = useRef(null)
  const timerRef = useRef(null)

  const close = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (wsRef.current) {
      try {
        wsRef.current.close()
      } catch {
        // ignore
      }
      wsRef.current = null
    }
  }, [])

  const subscribe = useCallback(
    (requestId, { onNotify } = {}) =>
      new Promise((resolve, reject) => {
        const tempUrl = import.meta.env.VITE_GRAPHQL_WS_URL
        if (!tempUrl) {
          reject(new Error("Realtime notifications are not configured."))
          return
        }
        try {
          const urlObj = new URL(tempUrl.replace("https://", "wss://"))
          const host = new URL(tempUrl).hostname
          urlObj.hostname = urlObj.hostname.replace("appsync-api", "appsync-realtime-api")
          const header = { host, Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}` }
          const wsUrl = `${urlObj.toString()}?header=${btoa(JSON.stringify(header))}&payload=e30=`

          const ws = new WebSocket(wsUrl, "graphql-ws")
          wsRef.current = ws

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: "connection_init" }))
            ws.send(
              JSON.stringify({
                id: requestId,
                type: "start",
                payload: {
                  data: JSON.stringify({
                    query:
                      "subscription OnNotify($request_id: String!) { onNotify(request_id: $request_id) { message request_id } }",
                    variables: { request_id: requestId },
                  }),
                  extensions: {
                    authorization: {
                      Authorization: `API_KEY=${import.meta.env.VITE_API_KEY}`,
                      host,
                    },
                  },
                },
              })
            )
          }

          ws.onmessage = (event) => {
            const message = JSON.parse(event.data)
            if (message.type === "start_ack") {
              resolve()
            } else if (message.type === "data" && message.payload?.data?.onNotify) {
              onNotify?.(message.payload.data.onNotify.message)
              close()
            } else if (message.type === "error" || message.type === "connection_error") {
              reject(new Error("Notification subscription failed."))
              close()
            }
          }

          ws.onerror = () => {
            reject(new Error("Notification connection error."))
            close()
          }

          timerRef.current = setTimeout(close, NOTIFY_TIMEOUT_MS)
        } catch (err) {
          reject(err)
        }
      }),
    [close]
  )

  useEffect(() => close, [close])

  return { subscribe, close }
}
