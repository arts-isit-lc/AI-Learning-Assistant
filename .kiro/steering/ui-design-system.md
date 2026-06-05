---
inclusion: fileMatch
fileMatchPattern: "frontend/**"
---

# UI Design System Contract

**Mandatory.** These rules apply to every component written or modified. Non-compliant code must be corrected before proceeding.

---

## Spacing — 4pt Grid Only
Use Tailwind spacing scale: `p-1`(4px) `p-2`(8px) `p-3`(12px) `p-4`(16px) `p-6`(24px) `p-8`(32px) `p-12`(48px) `p-16`(64px)

- No arbitrary values: `p-[13px]` is forbidden unless explicitly approved with inline comment
- No inline `style={{ padding }}` or `style={{ margin }}`
- Component internal padding convention: tight=`p-2` · default=`p-4` · loose=`p-6`

## Typography Scale
All text must use one of these classes — no arbitrary `text-[15px]`:

| Class | Usage |
|---|---|
| `text-xs` | Captions, helper text, timestamps |
| `text-sm` | Body text, table cells, form labels |
| `text-base` | Default readable content |
| `text-lg` | Section subheadings |
| `text-xl` | Page subheadings |
| `text-2xl` | Page headings |
| `text-3xl` | Hero / dashboard stat numbers |

Weight: `font-normal` (body) · `font-medium` (labels, buttons) · `font-semibold` (headings) · `font-bold` (emphasis only)

## Colour — Semantic Tokens Only
Use only the semantic token classes defined in `tailwind.config.js` and `index.css`. Never use raw palette classes like `bg-blue-600` or `text-gray-500` directly in app components — those belong only in the token definitions.

| Token class | Usage |
|---|---|
| `bg-background` / `text-foreground` | Page background and primary text |
| `bg-primary` / `text-primary-foreground` | Primary actions, active states |
| `bg-secondary` / `text-secondary-foreground` | Secondary surfaces, inactive states |
| `bg-muted` / `text-muted-foreground` | Disabled, placeholder, subdued content |
| `bg-destructive` / `text-destructive-foreground` | Delete, error, danger actions |
| `border-border` | All borders |
| `ring-ring` | Focus rings |

## No Inline Styles
```jsx
// FORBIDDEN
<div style={{ color: '#5536DA', maxWidth: '61vw' }}>

// REQUIRED
<div className="text-primary max-w-3xl">
```
Exception: dynamic values not expressible as Tailwind classes (e.g. `style={{ animationDelay: '0.2s' }}`). Document the exception inline.

## Surfaces and Layout
- All content surfaces use `Card`, `PageContainer`, or `SplitLayout` — no bare `<div>` with ad-hoc background colours
- No mixed layout systems at the same level (no flexbox + grid siblings)
- Maximum nesting depth: 4 levels of layout divs
- Vertical stacks: `flex flex-col gap-{n}` only
- Horizontal rows: `flex flex-row items-center gap-{n}` only
- Grids: only for multi-column dashboard/analytics layouts (`grid grid-cols-{n}`)
- Responsive: mobile-first — `flex-col` default, `md:flex-row` for wider breakpoints

## Component Completeness
Every interactive component must have all four states — do not ship with missing states:
- **Default** — normal appearance
- **Hover** — `hover:` prefix
- **Disabled** — `disabled:opacity-50 disabled:pointer-events-none`
- **Loading** — `Skeleton` placeholder or spinner; never a blank space

## Accessibility
- Keyboard accessible by default (shadcn/ui + Radix handles this automatically — don't override it)
- Icon-only buttons must have `Tooltip` and `aria-label`
- Form inputs must have associated `<label>` via `FormField` wrapper
- Never use colour alone to convey state — pair with text or icon
