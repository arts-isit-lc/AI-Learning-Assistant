---
inclusion: fileMatch
fileMatchPattern: "frontend/src/pages/student/**,frontend/src/components/**"
---

# Chat UX Patterns

Specific to the student chat interface. These patterns are fixed — do not deviate without explicit instruction.

---

## Page Structure
```
SplitLayout
+-- SessionSidebar (w-64, fixed, bg-secondary)
|   +-- Module title + BackButton
|   +-- Button "New Chat" (Plus icon, outline variant)
|   +-- Separator
|   +-- ScrollArea > SessionItem[] (reverse chronological)
+-- Main (flex flex-col, flex-grow)
    +-- PageHeader (fixed top, title="AI Assistant")
    +-- ChatThread (flex-grow, overflow-y-auto)
    |   +-- AIMessage[] / StudentMessage[]
    |   +-- TypingIndicator (conditional)
    |   +-- RetryBanner (conditional)
    +-- ChatInput (sticky bottom, mb-4 mx-8)
```

---

## Message Rules

**AIMessage:**
- Left-aligned, no bubble background
- Avatar: `Avatar` component, muted colour
- Content: `react-markdown` with `react-syntax-highlighter` (dracula theme) for code blocks
- Width: `max-w-3xl`
- Streaming: same component with `isStreaming=true` — subtle pulse indicator

**StudentMessage:**
- Right-aligned
- Bubble: `bg-secondary rounded-xl p-4`
- Avatar: `Avatar` component, primary colour
- Width: `max-w-xl`
- Delete: `ghost` icon button with `Trash2`, visible on hover of most-recent message that has an AI reply after it

**TypingIndicator:**
- Three dots, `animate-bounce` with staggered delay (0s, 0.2s, 0.4s)
- Shown only when `isAItyping && !streamingText`
- Never shown simultaneously with streaming text

---

## Session Sidebar Rules

**SessionItem states:**
- Default: `hover:bg-muted rounded-md px-3 py-2 text-foreground`
- Active: `bg-primary text-primary-foreground rounded-md px-3 py-2`
- Delete: `ghost` size `icon` button, right-aligned, appears on hover only
- Name: `truncate`, max one line

**New Chat button:**
- Always at top, `outline` variant, full width within sidebar padding
- Disabled while `creatingSession` is true
- Shows `Skeleton` SessionItem while creating

---

## Chat Input Rules
- `Textarea` auto-resizes on input up to `max-h-32`, then scrolls
- `placeholder="Message AI Assistant..."`
- `Enter` sends, `Shift+Enter` inserts newline
- Disabled (visually muted) while `isSubmitting || isAItyping || creatingSession`
- Send: `ghost` size `icon` button with `SendHorizontal` icon, same disabled conditions
- Max length: 2096 characters

---

## State Machine

| State | What shows |
|---|---|
| Loading sessions | `Skeleton` rows in sidebar + `Skeleton` rows in ChatThread |
| No sessions yet | Auto-create new session on mount |
| Creating session | `Skeleton` SessionItem in sidebar, `TypingIndicator` in thread |
| Idle, no messages | `TypingIndicator` (AI sends first message automatically) |
| AI typing, no stream | `TypingIndicator` |
| AI typing, streaming | `AIMessage isStreaming=true` with accumulated text |
| Stream complete | `AIMessage` with final persisted content (no flash between stream end and final message) |
| Error | `RetryBanner` below last message, single "Retry" button (`danger` variant) |
| Retrying | Same as AI typing state, `RetryBanner` hidden |

---

## What Never Happens
- No modal for errors — always inline `RetryBanner`
- No full-page spinner — skeleton at component level only
- No blank flash between streaming text and persisted message
- No send that bypasses the disabled check
- No duplicate session creation (`creatingSession` flag guards this)
- No swapped message types — `AIMessage` for AI, `StudentMessage` for student, never reversed
