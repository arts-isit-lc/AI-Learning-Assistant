---
inclusion: fileMatch
fileMatchPattern: "frontend/**"
---

# Frontend Conventions

> The frontend runs on a single **Tailwind + shadcn/ui** system (the OCELIA rebuild per
> `docs/ocelia-interface-rebuild-plan.md`). The legacy MUI interface was **fully removed in the Phase 8
> purge (2026-07-20)** — MUI/emotion, `lucide-react`, and `material-react-table` are no longer dependencies.

## Stack
React 18 (JSX only) · Vite 5 · React Router 7 (**data router**: `createBrowserRouter` + `RouterProvider`, nested layout routes, lazy routes) · **Tailwind 3 + shadcn/ui** (single UI system) · **Material Symbols icons** as per-icon SVG components via an `<Icon>` wrapper · **TanStack Query** (server state) · **React Hook Form + Zod** (forms + runtime API contracts) · Amplify v6 (auth/API) · react-markdown + react-syntax-highlighter · rehype-katex + remark-math · Recharts · react-toastify · react-pdf

## Key Rules
- Functional components only, no class components
- `import.meta.env.VITE_*` (never `process.env`)
- Amplify v6 modular imports: `import { fetchAuthSession } from 'aws-amplify/auth'`
- **Do not import MUI/emotion** (`@mui/*`, `@emotion/*`), `lucide-react`, or `material-react-table` — removed in the Phase 8 purge; don't reintroduce them (see Icons)
- Lazy-load routes via `React.lazy()` + `Suspense`
- Tests ship with the code — the frontend is no longer ESLint-only (see Testing)

## State Management
- **Server state → TanStack Query.** All REST data (courses, modules, prompts, analytics, roster, sessions). No raw `fetch()` + `useEffect` fetching in components.
  - **Data layer (landed Phase 3):** hooks in `src/services/queries/` (import from the barrel `@/services/queries`), Zod contracts in `src/services/schemas/`, keys via `src/services/queryKeys.js`. Every call goes through `src/services/http.js` — `withAuth` (401 → silent refresh → retry once → clear auth; 403 → inline) + `parseWith` (validates the response against its Zod contract; strict in dev). `createQueryClient` (`queryClient.js`) is provided **only inside `AppV2`**. Retries: GET ×2 backoff, **mutations never**. Errors → toast unless `error.inline` (403) or `meta.suppressGlobalError` (forms show field errors inline). Instructor/admin hooks are added in their feature phases (P6/P7).
  - **Realtime streaming (chat)** is the one exception to "server state → Query": the AppSync WebSocket stream lives in the feature hook `src/features/student/chat/useChatStream.js`. `streamingText` + the optimistic student bubble are local; the **final message is written into the `useSessionMessages` cache via `setQueryData`** so live + persisted history stay consistent. `POST student/chatbot-v2` (fire-and-forget streaming trigger) + `update_session_name`/`update_module_score` (best-effort) call `apiClient` directly — deliberate, they aren't cacheable data. Do not "migrate" these to Query.
  - **Instructor imperative flows (Phase 6)** follow the same exception: the module **file upload** (presigned URL → raw `XHR PUT` with progress), the **processing poller** (`setInterval`), the **draft-module lifecycle** (`reserve`/`cleanup` + `beforeunload`), and the chat-log **`onNotify` WebSocket** live as feature hooks in `src/features/instructor/hooks/` (`useFileUpload`, `useProcessingPoller`, `useDraftModule`, `useModuleTopics`, `useJobNotification`) and call `apiClient` directly — they're imperative/realtime, not cacheable server state. Everything else instructor-side (concepts/modules/prompt/analytics/roster/chatlog reads + all CRUD mutations) goes through Query hooks (`services/queries/instructor-*.js`). **Feature hooks are colocated with their feature so the Phase 8 legacy purge didn't orphan them.**
- **Global app state → Context, three only:** `AuthContext` (user, groups, `isInstructorAsStudent`), `CourseContext` (active course/module), `NotificationContext`. **No feature-level contexts** (`ChatContext`, `ModuleContext`, …).
- **Form state → React Hook Form + Zod.** Field/validation errors render inline via the form — never as toasts.
- **Typed API models:** Zod schemas as runtime contracts + JSDoc `@typedef`s for editor intellisense (the JSX equivalent of typed models).

## Styling
- Tailwind + **semantic tokens only** (`bg-background`, `text-foreground`, `bg-primary`, `bg-muted`, `border-border`, …). No raw palette classes (`bg-blue-600`) and no hardcoded hex/spacing in components.
- `cn()` from `src/lib/utils.js` for conditional classes.
- shadcn/ui primitives live in `src/components/ui/` — add more with `npx shadcn@latest add <component>`.
- Full token / spacing / typography / component-state rules live in `ui-design-system.md`; component names map to `ui-component-registry.md`. `#`-reference both for UI work.

## Icons
Google Material icons as **tree-shakeable per-icon SVG components** behind a thin `<Icon>` wrapper (via `react-icons/md` — already a dependency — or per-icon `@material-symbols/svg-*`). **Do not** ship the Material Symbols variable web font (loads every glyph, not tree-shakeable) and **do not** reintroduce `@mui/icons-material` or `lucide-react` (both removed in the Phase 8 purge — they pull MUI/emotion back in).

## Testing
- **Vitest + React Testing Library** — unit/component tests, colocated (`*.test.jsx`).
- **Playwright** — E2E smoke of critical flows.
- Every critical flow has **≥1 automated test**. Details + command names in `testing-policy.md`.
- Gate: ESLint + `npm run build` + tests. Harness **landed in Phase 1**: Vitest + RTL (jsdom, `src/test/setup.js`) via `npm run test`; Playwright via `npm run test:e2e`.

## Routing
**Data router** (`createBrowserRouter(routes)` + `<RouterProvider>` in `AppV2`; `routes` exported from `AppRoutes` via `createRoutesFromElements` under a `RootLayout` element) + nested layout routes + role guards (replacing the old `getHomePage()` switch). The data router (not the declarative `<BrowserRouter>`) is required so `useBlocker` works — it backs the app-wide `<UnsavedChangesPrompt when={isDirty} />` guard (unsaved-form navigation, incl. browser back/forward). `CourseProvider` + the lazy-route `Suspense` live in `RootLayout` (they read the location). **Resource IDs live in the URL** (e.g. `/courses/:courseId/modules/:moduleId`) so every screen is deep-linkable and refresh-safe — not held in top-level component state. No dead ends (every screen has a back/breadcrumb path); 404 route + redirects for legacy/invalid paths; Amplify SPA rewrite replaces the old `#/` hash routing.

**Navigation shell = top-nav `AppHeader` per role** (student/instructor/admin), **not** a left sidebar — the old `AppSidebar` assumption is retired (Phase 0). Instructor top-nav keeps Global Analytics + Global Chats as items wired to placeholder "coming soon" stubs; the header `Quicklink?` placeholder is dropped (no defined target). See `ui-component-registry.md`.

## Component Structure (three tiers)
```
src/components/ui/        # shadcn/ui primitives (Button, Input, Card, Dialog, …)
src/components/composed/  # Composed components (CourseCard, StudentRow, ModuleAccordion, WizardStepper, ChatSidebar, FileUpload, …)
src/features/<area>/      # Feature modules — hooks + queries + tests colocated (StudentChat, CourseWizard, ModuleEditor, AnalyticsGraph)
src/app/                  # App root (AppV2), routes (AppRoutes), role layouts, route guards
src/pages/dev/            # Dev-only pages (StyleGuide, Gallery) — the legacy src/pages/<role> pages were removed in Phase 8
src/context/              # AuthContext, CourseContext, NotificationContext (only)
src/services/             # api.js client · http.js (withAuth + parseWith) · queryClient · queryKeys · queries/ (hooks) · schemas/ (Zod contracts)
src/lib/                  # cn() + shared utils
src/constants/            # LLM models, etc.
```

## Legacy removal (Phase 8 — done)
The legacy MUI interface was **fully removed on 2026-07-20**. `LegacyApp` + the `VITE_UI_V2` strangler flag, `App.jsx`/`App.css`, all `src/pages/{admin,instructor,student}` pages (`Login`/`Container` included), the legacy top-level components, and `Theme.jsx` are deleted; **`main.jsx` renders `AppV2` directly** and owns `Amplify.configure`. MUI/emotion, `lucide-react`, `material-react-table`, and `@aws-amplify/ui-react` were dropped from `package.json`. There is no UI feature flag anymore — the OCELIA app is the only interface.
- Data tables use the registry `DataTable` (shadcn `Table` + TanStack Table).

## Commands
`npm run dev` · `npm run build` · `npm run lint` · `npm run preview` · `npm run test` (Vitest, single run) · `npm run test:watch` (Vitest watch) · `npm run test:e2e` (Playwright)
