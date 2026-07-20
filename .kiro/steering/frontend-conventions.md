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
  - **Data layer (landed Phase 3):** hooks in `src/services/queries/` (import from the barrel `@/services/queries`), Zod contracts in `src/services/schemas/`, keys via `src/services/queryKeys.js`. Every call goes through `src/services/http.js` — `withAuth` (401 → silent refresh → retry once → clear auth; 403 → inline) + `parseWith` (validates the response against its Zod contract; strict in dev). `createQueryClient` (`queryClient.js`) is provided **only inside `AppV2`**. Retries: GET ×2 backoff, **mutations never**. Errors → toast unless `error.inline` (403) or `meta.suppressGlobalError` (forms show field errors inline). Instructor/admin hooks are added in their feature phases (P6/P7).
  - **Realtime streaming (chat)** is the one exception to "server state → Query": the AppSync WebSocket stream lives in the feature hook `src/features/student/chat/useChatStream.js`. `streamingText` + the optimistic student bubble are local; the **final message is written into the `useSessionMessages` cache via `setQueryData`** so live + persisted history stay consistent. `POST student/chatbot-v2` (fire-and-forget streaming trigger) + `update_session_name`/`update_module_score` (best-effort) call `apiClient` directly — deliberate, they aren't cacheable data. Do not "migrate" these to Query.
  - **Instructor imperative flows (Phase 6)** follow the same exception: the module **file upload** (presigned URL → raw `XHR PUT` with progress), the **processing poller** (`setInterval`), the **draft-module lifecycle** (`reserve`/`cleanup` + `beforeunload`), and the chat-log **`onNotify` WebSocket** live as feature hooks in `src/features/instructor/hooks/` (`useFileUpload`, `useProcessingPoller`, `useDraftModule`, `useModuleTopics`, `useJobNotification`) and call `apiClient` directly — they're imperative/realtime, not cacheable server state. Everything else instructor-side (concepts/modules/prompt/analytics/roster/chatlog reads + all CRUD mutations) goes through Query hooks (`services/queries/instructor-*.js`). **Feature hooks are colocated with their feature so the P8 legacy purge doesn't orphan them.**
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
- Gate: ESLint + `npm run build` + tests. Harness **landed in Phase 1**: Vitest + RTL (jsdom, `src/test/setup.js`) via `npm run test`; Playwright via `npm run test:e2e`.

## Routing
`BrowserRouter` + nested layout routes + role guards (replacing the old `getHomePage()` switch). **Resource IDs live in the URL** (e.g. `/courses/:courseId/modules/:moduleId`) so every screen is deep-linkable and refresh-safe — not held in `App.jsx` state. No dead ends (every screen has a back/breadcrumb path); 404 route + redirects for legacy/invalid paths; Amplify SPA rewrite replaces the old `#/` hash routing.

**Navigation shell = top-nav `AppHeader` per role** (student/instructor/admin), **not** a left sidebar — the old `AppSidebar` assumption is retired (Phase 0). Instructor top-nav keeps Global Analytics + Global Chats as items wired to placeholder "coming soon" stubs; the header `Quicklink?` placeholder is dropped (no defined target). See `ui-component-registry.md`.

## Component Structure (three tiers)
```
src/components/ui/        # shadcn/ui primitives (Button, Input, Card, Dialog, …)
src/components/composed/  # Composed components (CourseCard, StudentRow, ModuleAccordion, WizardStepper, ChatSidebar, FileUpload, …)
src/features/<area>/      # Feature modules — hooks + queries + tests colocated (StudentChat, CourseWizard, ModuleEditor, AnalyticsGraph)
src/pages/<role>/         # Role pages (admin|instructor|student) that compose features/composed/ui
src/context/              # AuthContext, CourseContext, NotificationContext (only)
src/services/             # api.js client · http.js (withAuth + parseWith) · queryClient · queryKeys · queries/ (hooks) · schemas/ (Zod contracts)
src/lib/                  # cn() + shared utils
src/constants/            # LLM models, etc.
```

## Legacy coexistence (until Phase 8)
The old interface is migrated area-by-area; old and new coexist behind routing/feature flags until the last area cuts over.
- **The new shell is gated by `VITE_UI_V2`** (Phase 2). `App.jsx` switches between `AppV2` (new: `BrowserRouter` + role guards + Auth/Course/Notification contexts, under `src/app/`) and `LegacyApp` (the current MUI app). Unset/anything-but-`"true"` = legacy. `UserContext` + `Amplify.configure` stay in `App.jsx` — legacy pages still import `UserContext` from it. The flag + `LegacyApp` are deleted in Phase 8.
- **Don't touch legacy MUI pages except to migrate them.** When migrating a page, migrate the whole file — never partially convert.
- **Never mix `sx={{}}` (MUI) and Tailwind on the same element**; keep any still-MUI file internally consistent.
- MUI/emotion, `lucide-react`, and `material-react-table` are **legacy-only** — no new usage. They and `src/Theme.jsx` (the old `#5536DA` theme) are removed in Phase 8, after all areas migrate.
- New data tables use the registry `DataTable` (shadcn `Table` + TanStack Table), not `material-react-table`.

## Commands
`npm run dev` · `npm run build` · `npm run lint` · `npm run preview` · `npm run test` (Vitest, single run) · `npm run test:watch` (Vitest watch) · `npm run test:e2e` (Playwright)
