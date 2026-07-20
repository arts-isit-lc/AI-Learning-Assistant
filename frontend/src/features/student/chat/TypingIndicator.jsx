/**
 * Three-dot "AI is typing" indicator (chat-ux-patterns). Shown while the model
 * is processing before the first streamed token.
 */
export function TypingIndicator() {
  return (
    <div className="mb-6 flex items-center gap-2" role="status" aria-label="AI is typing">
      <div className="flex gap-1" aria-hidden="true">
        {[0, 0.2, 0.4].map((delay) => (
          <span
            key={delay}
            className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground"
            // dynamic stagger — not expressible as a Tailwind class
            style={{ animationDelay: `${delay}s` }}
          />
        ))}
      </div>
      <span className="text-caption text-muted-foreground">AI is typing&hellip;</span>
    </div>
  )
}
