import { useEffect, useRef } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { AIMessage } from "./AIMessage"
import { StudentMessage } from "./StudentMessage"
import { TypingIndicator } from "./TypingIndicator"
import { RetryBanner } from "./RetryBanner"

/**
 * Scrollable conversation. Renders persisted messages, the in-flight streaming
 * message, the typing indicator, and the retry banner (chat-ux-patterns state
 * machine). Announced to screen readers via role="log" aria-live.
 */
export function ChatThread({
  messages = [],
  streamingText = "",
  isTyping = false,
  retryError = null,
  onRetry,
  mostRecentStudentIndex = -1,
  hasAiMessageAfter = false,
  onDeleteMessage,
  loading = false,
}) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, streamingText, isTyping])

  if (loading) {
    return (
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-2/3" />
        ))}
      </div>
    )
  }

  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Conversation"
      className="flex flex-1 flex-col overflow-y-auto px-6 py-4"
    >
      {messages.map((message, index) =>
        message.student_sent ? (
          <StudentMessage
            key={message.message_id}
            content={message.message_content}
            isMostRecent={index === mostRecentStudentIndex}
            hasAiMessageAfter={hasAiMessageAfter}
            onDelete={onDeleteMessage}
          />
        ) : (
          <AIMessage key={message.message_id} content={message.message_content} blocks={message.blocks} />
        )
      )}
      {streamingText && <AIMessage content={streamingText} isStreaming />}
      {isTyping && !streamingText && <TypingIndicator />}
      {retryError && !isTyping && <RetryBanner onRetry={onRetry} />}
      <div ref={endRef} />
    </div>
  )
}
