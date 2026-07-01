---
inclusion: manual
---

# Figma to Code Workflow

Applies when using the Figma MCP to read designs. Never go directly from Figma node to code. Always follow this pipeline:

```
Figma nodes -> token extraction -> component mapping -> structured spec -> code
```

> The generic figma-to-code workflow (fetch context, screenshot, download assets, translate, validate) is provided by the **figma Power** steering `implement-design.md` — load that for the full pipeline. This file is the *project-specific overlay*: our token source of truth, component-registry mapping, and ambiguity rules.

---

## Step 1 — Reconcile Against Existing Tokens First

The source of truth for token **values** is code, never this file:
- Semantic colours / tokens: `frontend/src/index.css` + `frontend/tailwind.config.js`
- MUI theme (existing pages): `frontend/src/Theme.jsx` (primary `#5536DA`, bg `#F8F9FD`)
- Allowed classes + spacing/typography scales: `ui-design-system.md`

Extract tokens from the Figma frame, then map each to an existing semantic token. If a Figma value has no match, flag it — never invent a token without first updating `index.css` / `tailwind.config.js`. Never hardcode raw hex in components.

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

See `chat-ux-patterns.md` for the canonical chat interface spec — auto-loaded when editing student pages (`frontend/src/pages/student/**`); `#`-reference it when working on shared chat components under `src/components/`.
