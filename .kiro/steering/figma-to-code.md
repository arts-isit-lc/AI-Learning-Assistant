---
inclusion: manual
---

# Figma to Code Workflow

Applies when using the Figma MCP to read designs. Never go directly from Figma node to code. Always follow this pipeline:

```
Figma nodes -> token extraction -> component mapping -> structured spec -> code
```

---

## Step 1 — Extract Design Tokens First

Before writing any code, extract and normalize tokens from the Figma frame:

```json
{
  "tokens": {
    "colors": {
      "primary": "#2563eb",
      "primary-hover": "#1d4ed8",
      "background": "#ffffff",
      "surface": "#f8fafc",
      "muted": "#94a3b8",
      "destructive": "#dc2626",
      "border": "#e2e8f0",
      "foreground": "#0f172a"
    },
    "spacing": "4pt-grid",
    "radius": "0.5rem",
    "typography": {
      "xs": "12px", "sm": "14px", "base": "16px",
      "lg": "18px", "xl": "20px", "2xl": "24px", "3xl": "30px"
    },
    "theme": "light"
  }
}
```

Map extracted colours to CSS variable names in `src/index.css` (`--primary`, `--background`, etc.). If a Figma colour has no matching token, flag it — do not invent a token without updating `tailwind.config.js` and `index.css` first.

---

## Step 2 — Map Figma Nodes to Component Registry

Before writing JSX, produce a component map for the screen:

```json
{
  "screen": "StudentChat",
  "layout": "SplitLayout",
  "regions": {
    "sidebar": {
      "component": "SessionSidebar",
      "children": ["SessionItem", "Button"]
    },
    "main": {
      "layout": "flex flex-col",
      "children": [
        { "component": "PageHeader", "props": { "title": "AI Assistant" } },
        { "component": "ChatThread", "children": ["AIMessage", "StudentMessage", "TypingIndicator"] },
        { "component": "ChatInput" }
      ]
    }
  }
}
```

Every Figma node must resolve to a registry component (`ui-component-registry.md`). If a node cannot be mapped, either use the closest match or explicitly add a new entry to the registry before implementing it.

---

## Step 3 — Ambiguity Rules

Do not guess when Figma is unclear:

| Situation | Action |
|---|---|
| Node has no clear component match | Ask: "This looks like X or Y — which should it be?" |
| Colour not in token set | Flag: "Found `#7c3aed` with no matching token — should this be `primary` or a new `accent` token?" |
| Spacing off the 4pt grid | Flag: "Found 10px padding — should this be `p-2` (8px) or `p-3` (12px)?" |
| Hover/loading/error state missing | Ask which pattern to use, or apply the design system default from `ui-design-system.md` |
| Component not in registry | Add to registry first, then implement — never silently invent a component |

Never hallucinate a state, interaction, or component not present in the design or the registry.

---

## Step 4 — Handling Figma Updates (Diff and Reconciliation)

When a Figma frame is updated and code already exists:

1. Re-extract tokens from the updated frame
2. Compare against previously extracted tokens
3. Produce a change summary before touching any code:

```
Changed:
- Button radius: 4px -> 8px  (maps to --radius token update in index.css)
- Added: EmptyState on CourseView when no modules exist
- Removed: secondary action button from PageHeader on mobile

Unchanged:
- ChatThread layout
- Colour tokens
- Typography scale
```

4. Apply only the listed changes — do not rewrite surrounding code that is unaffected
5. If a token change is global (e.g. `--radius`), update `index.css` and note that all components using it update automatically

---

## Chat UI Patterns

See `chat-ux-patterns.md` for the canonical chat interface specification (loaded automatically when editing student/chat components).
