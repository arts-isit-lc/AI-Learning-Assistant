import { useEffect, useState } from "react"
import { onlineManager } from "@tanstack/react-query"

/**
 * Fixed banner shown while the browser is offline. React Query already pauses
 * queries/mutations when offline and refetches on reconnect (default
 * networkMode + refetchOnReconnect); this just makes the state visible to the
 * user (plan §10).
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => onlineManager.isOnline())

  useEffect(() => onlineManager.subscribe((isOnline) => setOnline(isOnline)), [])

  if (online) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-toast bg-warning px-4 py-2 text-center text-caption font-semibold text-warning-foreground"
    >
      You&rsquo;re offline. Changes are paused until your connection returns.
    </div>
  )
}
