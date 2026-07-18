---
inclusion: fileMatch
fileMatchPattern: "frontend/**"
---

# Frontend Conventions

> **OCELIA rebuild in progress (strangler migration).** The frontend is being rebuilt onto a single
> Tailwind + shadcn/ui system per `docs/ocelia-interface-rebuild-plan.md`. **New code follows the target
> conventions below** (the libraries are introduced across the rebuild phases). Legacy MUI pages coexist
> until migrated; MUI/emotion are removed only in Phase 8 — see [Legacy coexistence](#legacy-coexistence-until-phase-8).

## Target Stack (new code)
React 18 (JSX only) · Vite 5 · React Router 7 (`BrowserRouter`, nested layout routes, lazy routes) · **Tailwind 3 + shadcn/ui** (single UI system) · **Material Symbols icons** as per-icon SVG components via an `<Icon>` wrapper · **TanStack Query** (server state) · **React Hook Form + Zod** (forms + runtime API contracts) · Amplify v6 (auth/API) · react-markdown + react-syntax-highlighter · rehype-katex + remark-math · Recharts · react-toastify · react-pdf

## Key Rules
- Functional components only, no class components
- `import.meta.env.VITE_*` (never `process.env`)
- Amplify v6 modular imports: `import { fetchAuthSession } from 'aws-amplify/auth'`
- **New code must not import MUI/emotion** (`@mui/*`, `@emotion/*`) or `lucide-react` — see Icons + Legacy coexistence
- Lazy-load routes via `React.lazy()` + `Suspense`
- Tests ship with the code — the frontend is no longer ESLint-only (see Testing)

## State Management
- **Server state → TanStack Query.** All REST data (courses, modules, prompts, analytics, roster, sessions). No raw `fetch()` + `useEffect` fetching in components.
- **Global app state → Context, three only:** `AuthContext` (user, groups, `isInstructorAsStudent`), `CourseContext` (active course/module), `NotificationContext`. **No feature-level contexts** (`ChatContext`, `ModuleContext`, …).
- **Form state → React Hook Form + Zod.** Field/validation errors render inline via the form — never as toasts.
- **Typed API models:** Zod schemas as runtime contracts + JSDoc `@typedef`s for editor intellisense (the JSX equivalent of typed models).

## Styling
- Tailwind + **semantic tokens only** (`bg-background`, `text-foreground`, `bg-primary`, `bg-muted`, `border-border`, …). No raw palette classes (`bg-blue-600`) and no hardcoded hex/spacing in components.
- `cn()` from `src/lib/utils.js` for conditional classes.
- shadcn/ui primitives live in `src/components/ui/` — add more with `npx shadcn@latest add <component>`.
- Full token / spacing / typography / component-state rules live in `ui-design-system.md`; component names map to `ui-component-registry.md`. `#`-reference both for UI work.

## Icons
Google Material icons as **tree-shakeable per-icon SVG components** behind a thin `<Icon>` wrapper (via `react-icons/md` — already a dependency — or per-icon `@material-symbols/svg-*`). **Do not** ship the Material Symbols variable web font (loads every glyph, not tree-shakeable) and **do not** use `@mui/icons-material` (pulls MUI/emotion). `lucide-react` is legacy-only, not for new code.

## Testing
- **Vitest + React Testing Library** — unit/component tests, colocated (`*.test.jsx`).
- **Playwright** — E2E smoke of critical flows.
- Every critical flow has **≥1 automated test**. Details + command names in `testing-policy.md`.
- Gate: ESLint + `npm run build` + tests. (Harness established in rebuild Phase 1.)

## Routing
`BrowserRouter` + nested layout routes + role guards (replacing the old `getHomePage()` switch). **Resource IDs live in the URL** (e.g. `/courses/:courseId/modules/:moduleId`) so every screen is deep-linkable and refresh-safe — not held in `App.jsx` state. No dead ends (every screen has a back/breadcrumb path); 404 route + redirects for legacy/invalid paths; Amplify SPA rewrite replaces the old `#/` hash routing.

## Component Structure (three tiers)
```
src/components/ui/        # shadcn/ui primitives (Button, Input, Card, Dialog, …)
src/components/composed/  # Composed components (CourseCard, StudentRow, ModuleAccordion, WizardStepper, ChatSidebar, FileUpload, …)
src/features/<area>/      # Feature modules — hooks + queries + tests colocated (StudentChat, CourseWizard, ModuleEditor, AnalyticsGraph)
src/pages/<role>/         # Role pages (admin|instructor|student) that compose features/composed/ui
src/context/              # AuthContext, CourseContext, NotificationContext (only)
src/services/             # api.js client + TanStack Query hooks
src/lib/                  # cn() + shared utils
src/constants/            # LLM models, etc.
```

## Legacy coexistence (until Phase 8)
The old interface is migrated area-by-area; old and new coexist behind routing/feature flags until the last area cuts over.
- **Don't touch legacy MUI pages except to migrate them.** When migrating a page, migrate the whole file — never partially convert.
- **Never mix `sx={{}}` (MUI) and Tailwind on the same element**; keep any still-MUI file internally consistent.
- MUI/emotion, `lucide-react`, and `material-react-table` are **legacy-only** — no new usage. They and `src/Theme.jsx` (the old `#5536DA` theme) are removed in Phase 8, after all areas migrate.
- New data tables use the registry `DataTable` (shadcn `Table` + TanStack Table), not `material-react-table`.

## Commands
`npm run dev` · `npm run build` · `npm run lint` · `npm run preview` · `npm run test` (Vitest) · `npm run test:e2e` (Playwright) — test scripts added in rebuild Phase 1
