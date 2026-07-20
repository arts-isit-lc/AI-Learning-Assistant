---
inclusion: manual
---

# UI Design System Contract

**Mandatory.** These rules apply to every component written or modified. Non-compliant code must be corrected before proceeding.

---

## Spacing — 4pt Grid Only
Use Tailwind spacing scale: `p-1`(4px) `p-2`(8px) `p-3`(12px) `p-4`(16px) `p-6`(24px) `p-8`(32px) `p-12`(48px) `p-16`(64px)

- Named grid tokens also exist: `xs`(4) `sm`(8) `md`(16) `lg`(24) `xl`(32) — usable anywhere on the spacing scale (`p-md`, `gap-lg`, `w-xl`, …).
- No arbitrary values: `p-[13px]` is forbidden unless explicitly approved with inline comment
- No inline `style={{ padding }}` or `style={{ margin }}`
- Component internal padding convention: tight=`p-2` · default=`p-4` · loose=`p-6`

## Radius · Shadow · Motion · Z-index — Tokens
Never hardcode these — use the token utilities (values in `index.css`):

- **Radius:** `rounded-sm` (6px) · `rounded-md` (8px) · `rounded-lg` (12px).
- **Shadow:** `shadow-card` · `shadow-dropdown` · `shadow-modal` — match elevation to purpose.
- **Motion:** `duration-fast` (150ms) · `duration-normal` (250ms) with `ease-standard`; animations `animate-fade-in`, `animate-accordion-down/up`, `animate-indeterminate-progress`. Respect `prefers-reduced-motion`.
- **Z-index:** `z-base` · `z-dropdown` · `z-sticky` · `z-overlay` · `z-modal` · `z-toast` — never invent raw z-index values.

## Typography Scale
Font routes through **`--font-sans`** (Tailwind `font-sans`). Brand face is **Whitney**, assumed unavailable → fallback **Inter**; Whitney→Inter weight map: **Book → 400 (`font-book`)**, **Semibold → 600 (`font-semibold`)**. Swap point: one `@font-face` + the `--font-sans` value in `index.css` — no component edits.

**OCELIA named scale (from the Figma variables — prefer these):**

| Class | Size / line-height | Usage |
|---|---|---|
| `text-h2` | 34 / 46, semibold | Page / hero headings |
| `text-h4` | 18 / 28, semibold | Section subheadings |
| `text-body` | 18 / 28, book (400) | Default readable content |
| `text-caption` | 14 / 20 | Captions, helper text, labels, timestamps |

The Tailwind default steps (`text-xs`…`text-3xl`) remain available for finer control, but no arbitrary `text-[15px]`. Weight: `font-book`/`font-normal` (body) · `font-medium` (labels, buttons) · `font-semibold` (headings) · `font-bold` (emphasis only).

## Colour — Semantic Tokens Only
Use only the semantic token classes defined in `tailwind.config.js` and `index.css` (the **OCELIA / UBC Faculty of Arts** brand). Never use raw palette classes like `bg-blue-600` or `text-gray-500`, and never hardcode hex — those values belong only in the token definitions. Values are stored as HSL channels so alpha modifiers (`bg-primary/10`) compose.

| Token class | Usage |
|---|---|
| `bg-background` / `text-foreground` | Page background and primary text |
| `bg-card` / `text-card-foreground` | Card / surface backgrounds |
| `bg-primary` / `text-primary-foreground` | Primary actions, active states (Faculty of Arts purple `#6829C2`) |
| `bg-secondary` / `text-secondary-foreground` | Secondary surfaces, inactive states |
| `bg-muted` / `text-muted-foreground` | Placeholder, subdued content (muted-fg kept AA on white) |
| `bg-accent` / `text-accent-foreground` | Hover / subtle-highlight surfaces |
| `bg-navy` / `text-navy-foreground` | UBC navy `#002145` — headers / brand emphasis |
| `bg-destructive` / `text-destructive-foreground` | Delete, error, danger actions (`#E40000`) |
| `bg-destructive-muted` / `text-destructive-muted-foreground` | Subtle red background for error callouts (`#FFE6E6`) |
| `bg-success` / `text-success-foreground` | Success / complete (`#11A26F`) |
| `bg-warning` / `text-warning-foreground` | Warning / caution, prompt-conflict flag (`#A88F00`) |
| `bg-info` / `text-info-foreground` | Info / in-progress accent (cyan `#6EC4E8`) |
| `border-border` / `border-input` | Borders / input borders (`#BFBFBF`) |
| `ring-ring` | Focus rings (brand purple — visible-focus a11y) |

Never use colour alone to convey state — pair with text or an icon (see Accessibility).

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

## Component Completeness — Full Interactive-State Set
Every interactive element ships its **full, token-driven state set** (not just buttons — links, inputs, selects, toggles, tags, cards, list rows, tabs, nav items, icon buttons, accordions). Do not ship with missing states:
- **Default** — normal appearance
- **Hover** — `hover:` prefix
- **Focus-visible** — `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`; every hover affordance has a visible keyboard-focus equivalent (a11y DoD)
- **Active / pressed** — `active:` (e.g. `active:scale-95`)
- **Disabled / inactive** — `disabled:opacity-50 disabled:pointer-events-none`
- **Loading** (where applicable) — spinner/`Skeleton`, control disabled to block double-submit; never a blank space
- **Selected / checked** (where applicable) — toggles, tabs, nav items, cards
- **Error / invalid** (inputs) — inline via `FormField`, never a toast
- **Read-only** (where applicable)

State styles derive from **tokens** (no hardcoded hover/active colours) so they stay consistent everywhere. Where the Figma doesn't draw a state, apply the token-based default rather than leaving it ad-hoc.

## Accessibility
- Keyboard accessible by default (shadcn/ui + Radix handles this automatically — don't override it)
- Icon-only buttons must have `Tooltip` and `aria-label`
- Form inputs must have associated `<label>` via `FormField` wrapper
- Never use colour alone to convey state — pair with text or icon
