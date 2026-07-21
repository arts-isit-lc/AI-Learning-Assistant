---
inclusion: fileMatch
fileMatchPattern:
  - "frontend/src/features/student/**"
---

# Chat UX Patterns

Specific to the student chat interface. The **behavioral** rules (State Machine, What
Never Happens, streaming, TypingIndicator timing) are fixed — do not deviate without
explicit instruction. The **visual/layout** rules below were reconciled to the OCELIA
Figma module-chat frames (162:3817 / 214:5316 / 209:5164) on 2026-07-20 — the earlier
standalone "AI Assistant" SplitLayout was replaced; the behavior was preserved.

---

## Page Structure
The module chat is **embedded under the shared course chrome** (not a standalone layout):
```
StudentChat (mx-auto max-w-7xl, full height below AppHeader)
+-- CourseHeader (shared with CourseView) — collapsible via a "Reduce / Expand" toggle
+-- LearningJourneyBar (shared) — hidden when the header is collapsed
+-- Row (flex, min-h-0 flex-1)
    +-- SessionSidebar (w-72)
    |   +-- module title + back-to-course circle + new-chat icon button
    |   +-- "Previous chats" > ScrollArea > SessionItem[] (reverse chronological)
    |   +-- "Module materials" (collapsible, pinned bottom) — files open the doc column
    +-- ReferenceDocPanel (middle column, only when ?doc=:fileId) — bordered box
    +-- Chat box (bordered, rounded-sm, flex-grow)
        +-- "OCELIA ASSISTANT" heading (centred, top)
        +-- ChatThread (flex-grow, overflow-y-auto)
        |   +-- AIMessage[] / StudentMessage[]
        |   +-- TypingIndicator (conditional)
        |   +-- RetryBanner (conditional)
        +-- ChatInput (bottom, inside the box)
```
Materials open in the **middle reference-doc column** (3-column: sidebar · doc · chat), not a Sheet drawer.

---

## Message Rules

**AIMessage:**
- Left-aligned, **no bubble background**
- Marker: a small **purple triangle glyph** (▲, the OCELIA assistant mark) — not an avatar circle
- Content: `react-markdown` with `react-syntax-highlighter` (dracula) for code; block-based (text/figure/table/formula), each block wrapped in `ErrorBoundary` (chat-blanking fix — engineering-log)
- Streaming: same component with `isStreaming=true` — subtle caret/pulse indicator

**StudentMessage:**
- **Right-aligned, no bubble** — plain right-aligned text with a small **purple sphere** marker to its left
- Width: `max-w-xl`
- Delete: `ghost` icon button (`MdDelete`), on hover/focus of the most-recent student message that has an AI reply after it (keyboard-reachable, not hover-only)

**TypingIndicator:**
- Three dots, `animate-bounce` with staggered delay (0s, 0.2s, 0.4s)
- Shown only when `isAItyping && !streamingText`
- Never shown simultaneously with streaming text

---

## Session Sidebar Rules

**Module row (top):** module title + a back-to-course circle button (`‹`) + a new-chat **icon button** (top-right, `outline`/purple, `aria-label="New chat"`, disabled while creating). (Replaces the old full-width "New Chat" button.)

**SessionItem ("Previous chats") states:**
- Default: bordered box `rounded-sm border border-border`, purple filled chat glyph + purple name
- Active: `bg-primary text-primary-foreground` (filled purple)
- Delete: trash icon button, **always visible** on the row (keyboard-reachable)
- Name: `truncate`, one line

**Module materials:** a collapsible section pinned to the sidebar bottom; expanding lists the module's files, and selecting one opens it in the reference-doc column (active file = `bg-primary`).

---

## Chat Input Rules
- `Textarea` auto-resizes on input up to `max-h-32`, then scrolls
- `placeholder="Message OCELIA Assistant..."`
- `Enter` sends, `Shift+Enter` inserts newline
- Disabled (visually muted) while `isSubmitting || isAItyping || creatingSession`
- Send: `ghost` size `icon` button with a send icon, same disabled conditions
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
