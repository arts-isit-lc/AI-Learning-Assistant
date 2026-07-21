# OCELIA Interface Rebuild — Plan

**Status:** Phase 0 (Design Audit) complete — ready for Phase 1 · **Last updated:** 2026-07-17
**Scope:** Full frontend rebuild of the `frontend/` React SPA against the new "OCELIA" Figma designs.
**Backend:** Unchanged except for a small, greenlit gap-closing track (see [Backend track](#backend-track-parallel)).

---

## 1. Overview

Rebuild the entire user-facing interface (visual refresh **plus** state, routing, and component
architecture) on a single, consistent styling system, driven by the new OCELIA Figma designs and the
UBC / Faculty of Arts brand. The current app mixes MUI v9, Tailwind, and partial shadcn/ui; the rebuild
consolidates onto **Tailwind + shadcn/ui** and retires MUI/emotion.

The product is also being **rebranded to "OCELIA"** (the repo is currently `AI-Learning-Assistant`).

---

## 2. Definition of success

Connects the engineering work to product outcomes so stakeholders have a simple way to judge the project.

### How users will know it's better
- One consistent visual system (today it's a mix of MUI / Tailwind / partial shadcn).
- Faster loads and interactions; responsive down to tablet widths.
- Accessible by default (keyboard, focus, contrast).
- Fewer UI regressions, because critical paths are test-covered.

### Measurable improvements (targets)
See [§16 Performance & success metrics](#16-performance--success-metrics) for the numbers. In short:
Lighthouse Performance ≥ 90 / Accessibility ≥ 95 on key routes, bundle reduced ≥ 30% vs. baseline,
largest JS chunk < 500 KB gzipped, and an automated test for every critical user flow.

### What must NOT change
- **API compatibility** — REST contract (`api.js` endpoints) and AppSync realtime schema unchanged (except the greenlit backend track).
- **Auth** — Cognito flows and backend authorizers unchanged; client role checks remain UX-only.
- **Existing data** — no migrations to Postgres/DynamoDB content; no breaking data-shape changes.
- **Core workflows** — course join, student chat, module create/edit/view, prompt settings, admin/instructor CRUD keep working throughout the migration.

### What a successful rollout looks like
- All four design sets shipped on the new system; MUI/emotion fully removed.
- Tests green (Vitest/RTL + Playwright smokes); accessibility audit passed; performance targets met.
- No regression in core flows; stakeholder sign-off per area.

---

## 3. Assumptions

The plan depends on these holding true; if one breaks, revisit the affected phase.

- Existing REST APIs remain stable except the documented [backend track](#12-api-gap-analysis).
- Figma designs for an area are **approved before implementation** of that area (Phase 0 resolves open states first).
- **Amplify** remains the hosting/deployment platform.
- The **AppSync streaming contract** (chat chunks + notifications) is unchanged.
- **Cognito** remains the identity provider; user pool and group model are unchanged.
- **Whitney** remains unavailable until a web-embedding license is confirmed (fallback in use until then).
- The rebuild is built and validated entirely in the **`dev`** environment; **production is deployed only after full confirmation in dev**.

---

## 4. Out of scope

Explicitly **not** part of this project:

- Mobile redesign / dedicated mobile layouts (deferred; desktop-first built responsive only).
- Native mobile apps.
- Backend architecture rewrite.
- GraphQL/AppSync data-API migration (it stays realtime-only).
- TypeScript migration.
- Authentication redesign.
- Database schema changes.

The only backend work in this project is the minimal, greenlit gap track in [§12](#12-api-gap-analysis).

---

## 5. Locked decisions

| Decision | Choice | Notes |
|---|---|---|
| Target UI system | **Tailwind + shadcn/ui**; retire MUI/emotion | shadcn already partially configured |
| Language | **JSX** (no TypeScript) | Use Zod + JSDoc for "typed" API models |
| Icons | **Google Material icons as tree-shakeable per-icon SVG components** + thin `<Icon>` wrapper | Per-icon SVG imports (e.g. `react-icons/md` or `@material-symbols/svg-*`); **no icon web-font** (not tree-shakeable), **no** `@mui/icons-material` (pulls MUI) |
| Typography | **Whitney** (brand) — **assumed unavailable**; use fallback | See [font abstraction](#font-abstraction) |
| Responsive | **Desktop-first, built responsive**; mobile designs deferred | Protect nav shell + chat layout; tablet-safe floor |
| Scope | Visual refresh **+** state + routing + component architecture | Full rebuild |
| Backend | Unchanged except the greenlit gap track | See [§12](#12-api-gap-analysis) and Backend track |
| Server state | **TanStack Query (React Query)** | |
| Global app state | **Context** — `Auth`, `Course`, `Notification` only | No feature-level contexts |
| Form state | **React Hook Form + Zod** | All forms + the wizard |
| Testing | **Vitest + React Testing Library + Playwright** | Tests ship with each phase |

---

## 6. Dependencies & rationale

Six libraries are introduced. Each has a single, non-overlapping responsibility and replaces a
hand-rolled pattern — cohesive, not over-engineered.

| Library | Replaces | Responsibility |
|---|---|---|
| TanStack Query | custom `fetch` + `useEffect` loading/error/retry state | Server state: caching, retries, invalidation, dedup, optimistic updates |
| React Hook Form | manual `useState` form wiring | Form state + submission |
| Zod | handwritten validation + untyped API payloads | Schema validation + runtime API contracts |
| Vitest + RTL | no frontend tests | Unit/component testing |
| Playwright | manual regression testing | End-to-end smoke validation |
| @dnd-kit | hand-rolled drag-and-drop | Accessible (keyboard + pointer) drag-and-drop reorder of the Configuration Concept/Module tree |

Styling responsibility stays with **Tailwind + shadcn/ui**. No library overlaps another's job.

> **Server-side dependency (not a frontend library).** The greenlit chat-logs export (backend track **B5**,
> [§12](#12-api-gap-analysis)) adds a **Python xlsx writer** (e.g. `openpyxl` / `xlsxwriter`) to the chat-log
> Lambda so Excel (`.xlsx`) is generated **server-side**. This is deliberate: it keeps the frontend bundle
> lean (no client-side SheetJS), consistent with the −30% bundle target ([§16](#16-performance--success-metrics)).
> CSV is unchanged; the frontend only renders the table and links to the CSV/xlsx artifacts.

---

## 7. Design source

- **Figma file:** `OCELIA - May 2026` (file key `9Kt3RPFlZalJnPtCuHLObU`).
- **Second page** `Inspo + draft work` holds inspiration, the (deferred) mobile student set, and drafts — not in scope.

### The four sets (desktop)
1. **Student views** — Home (course grid), Course view (concepts, collapse/expand), Module chat (intro, mid-conversation, and a reference-doc panel variant).
2. **Admin views** — Instructor management (list + detail) and Course management (list + detail).
3. **Instructor views** — Courses list + a tabbed course area: Configuration, Insights, Settings, Chat History, Students.
4. **Module wizard** — Create (4 steps: name/concept → attach/upload references → prompt + key topics → review) and **Edit** (`Modal/EditModule` — a **single-page, all-fields** form). **Viewing** a module = expanding it in the Configuration tree (read-only summary + Edit/Delete).

Plus a shared **component library** (Header per role, Buttons UI/CTA families, Card/Course, List rows,
Profile headers, Tags, Toggle, Searchbar, Language-model dropdown, Alert, Table, Modal shell, Wizard
stepper, file-upload states) and the **CRUD/confirmation modals** (join course, add/duplicate course,
add/remove/delete instructor, delete/remove course, save changes, discard).

### Module flow model
- **Tree** → Configuration shows a **Concept (1) → Modules (many)** tree; concepts support **inline edit** (row pencil), **add**, and **delete** — **deleting a concept also deletes its modules**; concepts + modules are **drag-and-drop reorderable** (`@dnd-kit`).
- **Create** → 4-step wizard.
- **Expand (view)** → expanding a module shows a **read-only summary** + **Edit** / **Delete module**.
- **Edit** → **Edit** opens `Modal/EditModule` — a **single-page** form with **all** module fields editable (the wizard's fields, not stepped).

---

## 8. Design tokens

Extracted from the Figma variables. The design uses the **UBC / Faculty of Arts** brand system — a shift
from the current MUI theme (`#5536DA`, Roboto).

### Color
| Token | Value |
|---|---|
| Primary (Faculty of Arts purple) | `#6829C2` |
| UBC navy | `#002145` |
| Accent cyan (info / in-progress) | `#6EC4E8` |
| Success (green) | `#11A26F` |
| Destructive (red) | `#E40000` |
| Destructive-muted (subtle red bg) | `#FFE6E6` |
| Warning (yellow) | `#A88F00` |
| Neutrals | `#000000` · `#404040` · `#808080` · `#BFBFBF` · `#FFFFFF` |

Mapped to semantic tokens: `background`, `foreground`, `primary`, `secondary`, `muted`, `border`, `ring`, `destructive`, `destructive-muted`, `success`, `warning`, `info`.

### Typography
- Family: **Whitney** (H2 34/46, H4 18/28 semibold, Body 18/28 book; weights ~325 book / ~375 semibold).
- See [font abstraction](#font-abstraction) for the fallback strategy.

### Full token taxonomy (Phase 1)
All seven categories become tokens (CSS variables + Tailwind theme) so nothing gets hardcoded:

| Category | Tokens |
|---|---|
| color | brand + semantic (above) |
| typography | `--font-sans` + size/line-height/weight scale |
| spacing | `--space-xs / sm / md / lg / xl` (from the Figma grid) |
| radius | `--radius-sm / md / lg` |
| shadow | `--shadow-card / modal / dropdown` |
| motion | `--transition-fast / normal` + keyframes |
| z-index | `base / dropdown / sticky / overlay / modal / toast` |
| breakpoints | Tailwind `sm / md / lg / xl` (desktop-first, tablet floor) |

Spacing/radius come from the Figma grid; shadow/motion/z-index/breakpoints are defined as a system and shadow values confirmed during the design audit.

### Font abstraction
Whitney is a commercial (Hoefler&Co) typeface and is **assumed unavailable** for now.

- Typography routes through a single `--font-sans` CSS variable (and Tailwind `fontFamily.sans`).
- Current value: `Inter, ui-sans-serif, system-ui, sans-serif` (a close humanist sans).
- **Weight mapping** (Whitney has no Inter equivalent for 325/375): Whitney **Book → Inter 400**, **Semibold → Inter 600** (400 reads better than 300 at 18px body). Revisit when real Whitney is licensed.
- **Swap point:** when a UBC web-embedding license is confirmed, add one `@font-face` for Whitney and change the `--font-sans` value — no component changes required.
- Documented in `frontend/src/index.css` (token block) and a steering note.

---

## 9. Architecture decisions

### State management discipline
- **Server state → TanStack Query.** All REST data (courses, modules, prompts, analytics, roster, sessions).
- **Global app state → Context, three only:** `AuthContext` (user, groups, `isInstructorAsStudent`), `CourseContext` (active course/module), `NotificationContext`.
- **Form state → React Hook Form.**
- Explicitly **no** feature-level contexts (`ChatContext`, `ModuleContext`, `SettingsContext`, …) — those would recreate prop-drilling with providers. Chat, module, editing, and analytics state are server state (Query) or local form state (RHF).

### Data layer (its own phase)
Standardize every REST call on **TanStack Query** over the existing generic `api.js` client:
caching, retries, invalidation, optimistic updates, dedup, and consistent loading/error state.
Includes an auth/token interceptor and centralized error → toast handling.

**Typed API models (JSX-native):** **Zod schemas** as runtime API contracts + **JSDoc `@typedef`s** for
editor intellisense (the JSX equivalent of typed models, since the stack is JSX not TS).

### Forms
**React Hook Form + Zod** for create/edit course, prompts, settings, the module wizard, enrollment, edit/create module.

### Component ownership (three tiers)
| Tier | Location | Examples |
|---|---|---|
| Primitives | `src/components/ui/` | Button, Input, Select, Card, Dialog, Badge, Toggle, Tag, Alert, Table, Skeleton, Progress |
| Composed | `src/components/composed/` | CourseCard, StudentRow, PromptHistory, ModuleAccordion, ChatSidebar, WizardStepper, FileUpload, Searchbar |
| Feature | `src/features/<area>/` | ModuleEditor, CourseWizard, StudentChat, AnalyticsGraph (colocated with hooks + queries + tests) |

### Routing
`BrowserRouter` + nested layout routes + role guards (replacing the `getHomePage()` switch). Fix the
`#/` hash-vs-`BrowserRouter` mismatch and add the Amplify SPA rewrite rule. Keep lazy-loaded routes.

A **coherent, documented route map** replaces the current ad-hoc routing (which has dead ends and screens
that lose context on refresh):
- **Resource IDs live in the URL** — e.g. `/courses/:courseId/modules/:moduleId` — not in in-memory
  `App.jsx` state, so every screen is **deep-linkable and refresh-safe**. (Today `course`/`module` are React
  state, so refreshing or linking directly to a chat/course page breaks — a primary source of the dead ends.)
- **No dead ends:** every screen has a clear back/breadcrumb path and every action leads somewhere sensible.
- **404 / not-found** route + **redirects for legacy/invalid paths**; guarded routes redirect by role.
- The route map is drafted in Phase 0 (audit the current routing) and implemented in Phase 2.

### Icons
Google Material icons rendered as **tree-shakeable per-icon SVG components** through a thin `<Icon>` wrapper,
so only the icons actually used are bundled. Import individual SVGs (e.g. `react-icons/md`, or per-icon
`@material-symbols/svg-*` files) — **do not** ship the Material Symbols variable web font (loads every glyph,
not tree-shakeable) and **do not** use `@mui/icons-material` (pulls MUI/emotion). Steering
(`frontend-conventions`) updated to record the icon standard (replacing the lucide-only note).

### Interactive element states
Every interactive element ships the **full state set**, styled from tokens and matched to the mockups —
consistently across the whole library, not just buttons:

- **States:** default · hover · focus-visible (keyboard) · active/pressed · disabled/inactive · loading (where applicable) · selected/checked (toggles, tabs, nav items, cards) · error/invalid (inputs) · read-only (where applicable).
- **Applies to:** buttons (UI + CTA families), links, inputs, selects/dropdowns, toggles, tags, cards, list rows, tabs, nav items, icon buttons, accordions — anything a user can interact with.
- **Keyboard parity:** every hover affordance has a visible focus equivalent (ties to the a11y DoD).
- **Token-driven:** state styles derive from tokens (no hardcoded hover/active colors), so they stay consistent everywhere.
- **Mockup fidelity:** the designs already define many states (e.g. `Card/Course` = Default/Hover/Clicked/Inactive, `Button/Spinner` = loading, `UI` = Inactive/Hover). Phase 0 audits each interactive component's states in Figma; where a state isn't drawn, we define a consistent token-based default rather than leaving it ad-hoc.

---

## 10. Feedback: loading & error states

Consistent, centralized feedback wired into the data layer (Phase 3). The interface should always tell the
user what's happening — **every wait has a visible loading state**, every result is confirmed, and errors are
handled gracefully. Goal: a smooth, logical, intuitive feel. These states are implemented **even where the
mockups don't draw them.**

### Loading & async feedback
Any time the user waits — a query, a save/mutation, a multi-step flow, or a long-running backend job — show
an appropriate loading state; **never leave the UI static or ambiguous:**

- **Data loads** → skeletons (shadcn `Skeleton`) for initial page/section loads; inline spinners for small regions; Suspense boundaries so sections resolve independently.
- **Saves / mutations** → the triggering control enters its **loading state** (e.g. `Button/Spinner`) and is disabled to prevent double-submit, then confirms with a success toast (this is why every interactive element carries a loading state — see §9).
- **Multi-step flows (module wizard)** → each step shows progress and its own pending state on next/submit; steps that hit the backend (upload, `generate_topics`, finalize) show determinate progress where possible, indeterminate otherwise.
- **Long-running / async jobs (chat-log generation, file processing, topic generation)** → show a clear "processing…" state and poll or subscribe (AppSync `onNotify`) for completion, resolving to a done/failed result — never a frozen screen.
- **Streaming chat** → typing indicator until the first token, then render tokens as they stream so replies feel live.
- **Optimistic where safe** → quick, low-risk actions (toggles, reorder, rename) update immediately and reconcile on response (rollback per below).
- **Perceived performance** → debounce searches; keep skeleton/layout dimensions stable to avoid layout shift; prefer optimistic/streaming over spinners when safe.

### Errors
- **Toasts vs. inline.** Transient/unexpected errors → toast (react-toastify). Field/validation errors → **inline** via RHF + Zod (never a toast). Success confirmations → brief toast.
- **Retry.** Query retries idempotent **GET**s (≈2 attempts, exponential backoff). **Mutations do not auto-retry** (avoid duplicate writes) — surface a user-triggered "retry" instead.
- **Unauthorized.** `401` → attempt silent token refresh via Amplify; on failure, clear auth and redirect to login. `403` → inline "you don't have access" message (no redirect).
- **Offline.** Detect connectivity (`navigator.onLine` + Query network mode); pause mutations, show an offline banner, and refetch on reconnect.
- **Optimistic rollback.** Any optimistic mutation implements `onError` rollback to the previous cache snapshot + a toast. Used sparingly (toggles, reorder) — never for destructive actions.

---

## 11. Accessibility policy

Accessibility is a **Definition of Done for every component and screen**, from the component phase onward:
keyboard support, visible focus, correct ARIA roles/labels, and color contrast checked against the tokens.
The final phase is only a **WCAG-AA audit/verification**, not the first pass.

> Note: full WCAG conformance requires manual testing with assistive technologies and expert review; this
> plan builds a11y in by default and verifies at the end, but does not claim automated certification.

---

## 12. API-gap analysis

Backend is REST (API Gateway + instructor/student/admin Node Lambdas). AppSync GraphQL is realtime-only
(notifications + chat streaming), not a data API. `frontend/src/services/api.js` is a generic REST client;
endpoints are called inline in pages.

**Already supported** (no backend work): prompt versioning (`previous_prompts`), prompt conflict detection
(`validate_prompt` + stored `conflict_metadata`), auto-suggested key topics (`generate_topics`), module
create/edit/view, file upload + references, chat-log **CSV generation** (async job → presigned S3 URLs),
roster, course access codes, student enrollment/progress/sessions/file viewing, per-module message-count analytics.

### Gaps (greenlit backend track)
| Gap | Status | Resolution |
|---|---|---|
| Insights "engagement over time" | per-module only, no time buckets | **Deferred (B1, team finalization)** — time-series query, later; Insights ships the current chart |
| Insights "content reach" + "clear data" | reach approximated by `access_count`; no reset route | **Deferred (B1, team finalization)** — reach metric + clear-data route, later |
| Course **duplicate** | **Done (B2, 2026-07-20)** | `POST /admin/duplicate_course` — clones the course row + concept/module **outline** (metadata via `INSERT…SELECT`); not files, embeddings, enrolments, or student data |
| Student join code | design says "6-digit"; backend emits 16-char grouped | **Keep 16-char code, change mockup copy** (6-digit numeric is brute-forceable — security) |
| Instructor **OCELIA access** toggle | **Done (B4, 2026-07-20)** | Course toggle → existing `course_student_access`; per-instructor toggle → **new `Enrolments.access_enabled`** column + `POST /admin/updateInstructorAccess` (reads returned on `courseInstructors`/`instructorCourses`). Per-item add/remove use `enroll_instructor` + new `DELETE /admin/unenroll_instructor` so other flags stay intact |
| Chat-logs **in-app table + Excel** | today: async job writes a **CSV** to S3 (presigned URLs); no row data, no `.xlsx` | Return chat-log **rows as JSON** for the in-app Chat History table **and** add **server-side `.xlsx`** export (extend the `course_messages` job); CSV unchanged |
| Concept-delete **cascade cleanup** | DB `ON DELETE CASCADE` deletes concept→module→file/session/progress **rows**, but **S3 objects + pgvector embeddings are orphaned** (rows are hard-deleted, so `orphanCleanup` never catches them) | **Mark-and-sweep:** `delete_concept` marks its modules `status='deleting'` + triggers async cleanup (embeddings + S3 + rows via `cleanup_module`) and returns immediately; the concept row is removed only after its modules are swept (so the cascade can't hard-delete them first). `orphanCleanup` stays as the scheduled backstop; the same path fixes `delete_module` / `delete_course` orphaning |

The frontend rebuild does **not** depend on these to ship most screens; they run as a small parallel track.
The chat-logs table (Chat History tab) is the one screen that **does** depend on its gap (B5) for full function —
it degrades to the existing CSV-download links until B5 lands.

---

## 13. Phased plan

Each phase lists its **exit criteria** — objective, unambiguous conditions that must be true to move on.

### Phase 0 — Design audit
Pull each screen (`get_design_context` + screenshots) and produce a punch-list: screen inventory,
reusable-component map, inconsistencies (e.g., duplicate `Settings/H` frames, 6-digit vs 16-char code,
accordion shown only collapsed), and missing empty / loading / error / interaction / responsive states.

**Exit when:**
- Every in-scope screen is inventoried and mapped to components.
- Every missing state (empty/loading/error/interaction/responsive) is documented.
- All inconsistencies are logged and resolved with the stakeholder.
- No unknown states remain for the screens in the first two slices (Student, Instructor).
- A navigation/route map is drafted from the designs (each screen's entry, exit, and back path), and the current app's dead-end / illogical routes are catalogued for redesign in Phase 2.
- Interactive-element **states are inventoried per component** (hover / focus / active / disabled / loading / selected / error); states not drawn in Figma are flagged so we can define consistent token-based defaults.

### Phase 1 — Foundations
Tokens, fonts, icons, steering.

**Exit when:**
- All 7 token categories exist as CSS vars + Tailwind theme; a token preview renders.
- `--font-sans` fallback in place and the Whitney swap point documented.
- `<Icon>` (Material Symbols) works; no `@mui/icons-material` in new code.
- `frontend-conventions` + `testing-policy` steering updated (icons + FE tests).
- **Bundle baseline captured** (for the −30% target).

### Phase 2 — App shell & architecture
Routing, layouts, global contexts.

**Exit when:**
- `BrowserRouter` + nested layouts + role guards live; Amplify SPA rewrite / hash fix done.
- `AuthContext` + `CourseContext` + `NotificationContext` implemented; no new prop-drilling.
- Role shell + master-detail layout + `ErrorBoundary` + toasts render for every role.
- Role-guard tests pass.
- Documented route map implemented: resource IDs in the URL; every screen reachable, deep-linkable, and refresh-safe; no dead ends; 404 + legacy redirects in place.

### Phase 3 — Data layer
TanStack Query over `api.js`.

**Exit when:**
- Every REST endpoint used so far goes through Query hooks.
- **Zero raw `fetch()` / ad-hoc `useEffect` fetching remains** in migrated code.
- Auth/token interceptor complete; centralized loading + error handling (per [§10](#10-feedback-loading--error-states)) works.
- Zod contracts + JSDoc models exist for the endpoints consumed so far.

### Phase 4 — Component library
`ui/` primitives → `composed/` components.

**Exit when:**
- All primitives + composed components from the design set are built and in the gallery route.
- Each ships with a11y (keyboard/focus/ARIA/contrast) and Vitest/RTL tests.
- Every interactive component implements its **full state set** (default/hover/focus/active/disabled/loading/selected/error, as applicable) matching the mockups; the gallery renders **each state**.
- No component imports MUI.

### Phase 5 — Student slice (+ first Playwright smoke)
Home, Course, Module chat (streaming), join-by-code.

**Exit when:**
- All student screens implemented against real endpoints; chat streaming works via AppSync.
- Playwright smoke covers login → course → module chat.
- Responsive holds down to the tablet floor; a11y DoD met.

### Phase 6 — Instructor
Tabbed course area + wizard + settings + insights + chat history + roster.

**Exit when:**
- Configuration (Concept→Module tree + drag-and-drop reorder; expand → read-only summary + Edit modal), create/edit wizard, Settings (model/prompts; **conflict-check-on-save** with override-via-confirm), Chat History (virtualized table + CSV/Excel export), Students all implemented.
- Insights **ports the current analytics chart** (messages/module + per-module stats); the metric switcher, tag filters, Clear data, and Export are out for now — engagement/reach/clear-data (**B1**) deferred pending team finalization.
- Feature-area tests + a11y DoD met.

### Phase 7 — Admin
Instructor + course management + CRUD/confirmation modals.

**Exit when:**
- Instructor management (assign/access/add/remove/delete) and course management (add/duplicate/delete/access codes) implemented.
- All CRUD/confirmation modals wired; tests + a11y DoD met.

### Phase 8 — Cleanup, rebrand, performance, a11y audit

**Exit when:**
- **All traces of the old interface deleted (no soak period):** no file imports MUI/emotion; `Theme.jsx` + `@mui/icons-material` + legacy pages/routes/assets removed; feature flags removed; old dependencies dropped from `package.json`.
- OCELIA rebrand complete (title, logo, `package.json` homepage, README).
- **Performance targets met** ([§16](#16-performance--success-metrics)); bundle analysis run.
- WCAG-AA audit passed (or documented exceptions).

### Backend track (parallel)
- **B1** *(deferred — team finalization)* analytics time-series + content-reach + clear-data. **Not in the initial rebuild** — the Insights tab ships the current `instructor/analytics` chart only (metric switcher / tag filters / Clear data / Export removed for now).
- **B2** *(done 2026-07-20)* course duplicate route — `POST /admin/duplicate_course` clones the course row (copying `llm_model_id`) + the concept/module **outline** (metadata; not files, embeddings, enrolments, or student data). Consumed by the admin Course detail (Duplicate).
- **B3** join-code copy reconciliation (keep 16-char).
- **B4** *(done 2026-07-20)* OCELIA-access toggles: **course Active/Inactive** → existing `Courses.course_student_access` (no change); **per-instructor "OCELIA access"** → **new `Enrolments.access_enabled` column** (idempotent migration, default TRUE) + `POST /admin/updateInstructorAccess`; the flag is returned on `courseInstructors`/`instructorCourses`. Per-row add/remove use `enroll_instructor` + new `DELETE /admin/unenroll_instructor` (single pair) so sibling flags aren't reset. Consumed by the admin Course + Instructor detail panes.
- **B5** chat-logs: return rows-as-JSON for the in-app Chat History table + **server-side `.xlsx`** export (extends the `course_messages` job; CSV unchanged). Consumed by Phase 6.
- **B6** concept-delete cascade cleanup (**mark-and-sweep**): `delete_concept` marks its child modules `status='deleting'` and triggers async cleanup (pgvector embeddings + S3 objects + rows, reusing `orphanCleanup.cleanup_module`), returning immediately; the concept row is deleted once its modules are swept, so the DB row-cascade never hard-deletes modules before their S3/vectors are cleaned. `orphanCleanup` remains the scheduled backstop. Consumed by Phase 6.
- **B7** *(done 2026-07-20)* student course-card progress — `GET /student/progress_summary` returns per-course `{course_id, percent, completed, total}` for the student's accessible enrolled courses in ONE SQL aggregate (a concept is complete when its active modules average a score of 100 — mirrors the course page / Learning Journey). Powers the home `Card/Course` progress line without a per-card `course_page` fetch (no N+1); progress is its own resource/cache, invalidated independently of the stable course list. No new IAM (reuses `studentFunction`/`dbLambdaRole`); inherits the handler's email-vs-authorizer 401 guard. Consumed by Phase 5 (Student Home).

**Exit when:** each route implemented with CDK Jest assertions + Lambda/pytest per `testing-policy`, and consumed by the relevant frontend phase.

---

## 14. Phase dependency graph

```
P0  Design audit
      |
P1  Foundations (tokens/fonts/icons)
      |
P2  App shell & architecture
      |
P3  Data layer
      |
P4  Component library
      |
P5  Student slice
      |
      +-----------------+
      |                 |
P6  Instructor        P7  Admin        (P6 and P7 are parallel after P5)
      |                 |
      +--------+--------+
               |
P8  Cleanup / rebrand / performance / a11y audit

Backend track (B2-B6; B1 deferred): runs in parallel from P3 onward; consumed by P6/P7.
```

P6 and P7 can proceed in parallel once P5 has validated the stack end-to-end. Everything from P4 onward
consumes the single data layer from P3.

---

## 15. Testing strategy

- **Frontend:** Vitest + React Testing Library (unit/component) + Playwright (E2E smoke). Tests ship with
  each phase. Priority targets: prompt validation, chat streaming, contexts, routing, permissions/role
  guards, wizard state, formatters, module status.
- **Behavioral bar:** every critical user flow has **at least one automated test** (unit, component, or Playwright) — not a coverage percentage.
- **Gate:** ESLint + `npm run build` + tests + per-screen manual QA + a11y checks.
- **Backend (only where touched):** CDK Jest `Template` assertions + Lambda/pytest per `testing-policy`.
- Steering (`testing-policy`, `frontend-conventions`) updated: the frontend is no longer "ESLint-only."

---

## 16. Performance & success metrics

Measurable targets (validated in Phase 8; **baseline captured in Phase 1** before MUI removal):

| Metric | Target |
|---|---|
| Lighthouse — Performance (key routes, desktop) | ≥ 90 |
| Lighthouse — Accessibility | ≥ 95 |
| First Contentful Paint (broadband, mid-tier laptop) | < 1.5 s |
| Largest Contentful Paint | < 2.5 s |
| Largest JS chunk (gzipped) | < 500 KB |
| Total bundle vs. Phase-1 baseline | ≥ 30% reduction |
| Automated test per critical flow | login/role-routing, course join, student chat + streaming, module create/edit, prompt save + conflict, admin CRUD each have ≥ 1 automated test |
| Async feedback | every data load, save, wizard step, and long-running job (chat-log generation, file/topic processing) shows a loading/progress state — no static or ambiguous waits |
| Interactive-state coverage | every interactive component provides hover / focus-visible / active / disabled (+ loading / selected / error where applicable), matching the mockups |
| Styling / data / routing hygiene | 0 MUI imports · 0 raw `fetch()` in pages · no hardcoded hex/spacing outside tokens · icons imported per-icon (no icon web-font) · every screen reachable + deep-linkable, no dead-end routes |

Key routes for measurement: Student Home, Student Module chat, Instructor Course (Configuration).

### Performance techniques (checklist)
- Lazy-load routes + code-split per area.
- Virtualize long tables/lists (Chat History, admin/instructor lists).
- Memoize expensive chat message rendering.
- Suspense boundaries + skeletons for data-backed views.
- Image handling for reference docs/figures.
- Bundle analysis in Phase 8 (expect a reduction from dropping MUI).

---

## 17. Migration, rollback & deployment

**Strategy:** strangler — build new screens alongside the old and switch per area via routing; old and new
coexist until each area is cut over.

- **Environments — dev first.** The entire rebuild (all phases, per-area cutovers, and old-interface removal) is built and validated in the **`dev`** environment. **Production is deployed only after the full new interface is confirmed good in dev** — a single promotion, not incremental per-area cutovers in prod. (`environment` = `dev` | `prod` in the CDK context; `${StackPrefix}` naming.)
- **Branch strategy.** `main` protected; one feature branch per phase/area (e.g. `rebuild/phase-3-data-layer`, `rebuild/student`); PR + review per area; never push to `main` directly.
- **Feature flags.** A top-level flag (e.g. `VITE_UI_V2`) gates the new shell; per-area routing lets old and new coexist during migration. Flags removed in Phase 8.
- **Deployment.** Amplify hosting with branch/preview deploys for QA; frontend via `npm run build`. The CDK `predeploy` hook runs `npm test` — never bypass.
- **Coexistence & rollback.** Because each area is switched independently behind routing/flags, any area can be reverted by flipping its flag or reverting its branch. MUI is removed only after the last area migrates (Phase 8), so rollback stays cheap until then.
- **Decommission — no soak period.** Once the new interface is confirmed good across all areas, **all traces of the old interface are deleted immediately** (no burn-in window) and we move forward — see Phase 8. After that point, git history + a pre-removal tag is the only fallback.

---

## 18. Browser support

Latest **Chrome, Edge, Firefox, and Safari** (desktop-first). Internet Explorer is **not** supported.
Tablet widths are supported via responsive layout; dedicated mobile designs are deferred.

---

## 19. Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Whitney font licensing | Low | Low | Abstracted `--font-sans` fallback; one-line swap when licensed |
| Design inconsistencies / missing states | High | Medium | Phase 0 audit + punch-list resolved before building |
| Backend track delay | Medium | Medium | Frontend ships against existing endpoints; Insights/duplicate gated and degrade gracefully |
| Streaming (chat) regressions | Medium | High | Preserve AppSync contract; validate in the Phase 5 slice; Playwright + manual QA on chat |
| Query migration bugs | Medium | High | Data-layer phase first; Zod contracts catch shape drift; per-query tests; incremental per-area migration |
| Auth / routing regressions | Medium | High | Role-guard tests + smoke; Cognito flows preserved; client checks stay UX-only |
| Dependency surface / scope creep | Low | Medium | Locked decisions + rationale table ([§6](#6-dependencies--rationale)); no feature contexts |
| Webfont / bundle regression | Low | Medium | Subset fonts, measure against budget, enforce chunk-size target |

---

## 20. Plan score

**~9.0 / 10.** Strong on architecture, production readiness, security, completeness, testability,
performance, and maintainability. The honest tension is **simplicity** (added dependency surface, justified
in [§6](#6-dependencies--rationale)). Residual risk is concentrated in Phase 0 design-audit findings rather than plan gaps.

---

## 21. Decision log & ADRs

Significant **future** architecture changes — e.g., replacing Context with another state solution, adopting
TypeScript, or migrating off AppSync — require an **Architecture Decision Record (ADR)** in
`docs/architecture/` before implementation, to prevent undocumented design drift. The log below records the
decisions made while shaping this plan.

| Date | Decision |
|---|---|
| 2026-07-14 | UI system: Tailwind + shadcn; retire MUI. JSX. Material Symbols icons. |
| 2026-07-14 | Desktop-first, built responsive; mobile designs deferred. |
| 2026-07-14 | Backend unchanged except greenlit gap track (analytics, duplicate, join-code, access toggle). |
| 2026-07-14 | Whitney assumed unavailable → abstracted `--font-sans` fallback (Inter). |
| 2026-07-14 | Adopt TanStack Query (server state), Context for global-only state, RHF + Zod (forms). |
| 2026-07-14 | Add Vitest + RTL + Playwright; tests ship per phase. |
| 2026-07-14 | Accessibility is Definition of Done per component; Phase 8 is audit only. |
| 2026-07-14 | Added Phase 0 design audit and a dedicated data-layer phase. |
| 2026-07-14 | Added Definition of Success, per-phase exit criteria, measurable metrics, dependency graph, library rationale, error-handling strategy, expanded rollback/deployment, browser support, and a rated risk register. |
| 2026-07-14 | Added Assumptions and Out-of-scope sections; clarified test bar as "≥1 automated test per critical flow"; required ADRs for future architecture changes. |
| 2026-07-14 | No soak period: once the new interface is confirmed good across all areas, delete all traces of the old one (code, MUI/emotion deps, feature flags) and move forward; git history + pre-removal tag is the only fallback. |
| 2026-07-14 | Rebuild is built and validated entirely in the `dev` environment; production is deployed only after full confirmation in dev (single promotion, not per-area in prod). |
| 2026-07-14 | Icons must be tree-shakeable per-icon SVGs (no icon web-font, no `@mui/icons-material`). Routing reworked into a coherent, deep-linkable route map: resource IDs in the URL, no dead ends, 404 + legacy redirects. |
| 2026-07-14 | All interactive elements must implement a consistent, token-driven state set (default/hover/focus/active/disabled/loading/selected/error) matching the mockups; audited in Phase 0, enforced in Phase 4 + the a11y DoD. |
| 2026-07-14 | Every user wait shows a loading/progress state (data → skeletons; saves → button spinner + disable; wizard steps + long jobs → progress/polling; chat → streaming); no static/ambiguous waits — for a smooth, intuitive feel. Implemented even where mockups omit it. |
| 2026-07-17 | Phase 0 audit: chat-logs live in the **Chat History** tab as an in-app table + **CSV and Excel** download. Excel is **server-side `.xlsx`** (new backend track **B5**; Python `openpyxl`/`xlsxwriter` in the chat-log Lambda), not client-side — keeps the frontend bundle lean. CSV generation unchanged. |
| 2026-07-17 | Phase 0 audit: Configuration = **Concept (1) → Modules (many)** tree; concepts support **inline edit** (row pencil) + add + delete, and **concept delete cascade-deletes its modules**; concepts + modules **drag-and-drop reorderable** (adds **@dnd-kit**). Module **view = expand** (read-only summary + Edit/Delete); **module Edit = `Modal/EditModule`**, a single-page all-fields form (wizard fields, not stepped) — modules have no inline tree editing. |
| 2026-07-17 | Phase 0 backend check: DB **already cascades** concept→module→files/sessions/progress rows (`ON DELETE CASCADE`), but **S3 objects + pgvector embeddings are not cleaned up** on concept/module/course delete → orphans (`orphanCleanup` only catches draft/deleting rows, not hard-deleted ones). Added **B6** (concept-delete runs full per-module cleanup via `orphanCleanup.cleanup_module`), using **mark-and-sweep** (mark child modules `deleting` + async cleanup; concept row deleted after sweep; API returns fast; `orphanCleanup` is the backstop). |
| 2026-07-17 | Phase 0 audit (Settings/prompt): **remove the `Check for conflicts` button** — run `validate_prompt` **on Save**. On conflict, **block + show conflicts** (Save stays enabled); **re-clicking Save with conflicts unaddressed → warning confirm modal → save anyway (override)**; editing the prompt re-checks on the next Save. Frontend orchestration only — no backend gap. The Settings-tab **dot flags an unresolved prompt conflict** (from stored `conflict_metadata`), persisting after override-save until the prompt is edited conflict-free — **not** an unsaved-changes indicator. |
| 2026-07-17 | Phase 0 audit: instructor top-nav **Global Analytics** + **Global Chats** kept as nav items but wired to **placeholder stub pages** ("coming soon") for now (not designed/scoped features). The header **`Quicklink?`** button is **omitted** from the initial build until its action/target is defined. |
| 2026-07-17 | Phase 0 audit (Phase-1 tokens): **add** `warning` (`#A88F00`), `destructive-muted` (`#FFE6E6`), and `info`/`in-progress` (cyan `#6EC4E8`) semantic tokens. **Define the full type scale** as tokens (H2 34/46 · H4 18/28 semibold · Body 18/28 book + caption/label). **Whitney→Inter weight map:** Book → 400, Semibold → 600. |
| 2026-07-17 | Phase 0 audit (student slice): **OQ-10** course-wide "student files" area **cut** (placeholder dropped). **OQ-12** Learning Journey drawer = **progress tracker**, reuse existing course/module progress (`useCourseProgress`/`useModuleProgress`), design largely unchanged. **OQ-13** canonical module-chat states confirmed: intro · mid-conversation · expanded · slide-in materials drawer · reference-doc. |
| 2026-07-17 | Phase 0 audit: **approved** reconciling the component registry + `frontend-conventions` nav to the **top-nav model** (retire the `AppSidebar` assumption) and adding the ~15 missing primitives/composed components — done in **Phase 1**, before Phase 4. **Join code:** confirmed **keep the 16-char** access code; reword the "6-digit" mockup copy (B3). |
| 2026-07-17 | Phase 0 audit (Insights): scope cut — Insights **ports the current `instructor/analytics` chart** (messages/module + per-module stats), restyled. **Removed** the Messages/Student-Engagement/Content-Metrics switcher, tag filters, **Clear data**, and **Export**. Engagement-over-time + content-reach + clear-data (**B1**) **deferred** for team finalization. |
| 2026-07-17 | Phase 0 audit (OQ-7 access toggles): two distinct concepts — course **Active/Inactive** → existing `Courses.course_student_access` (no backend change); **per-instructor "OCELIA access"** → **new `Enrolments.access_enabled`** column + route (**B4**, in scope). |
| 2026-07-17 | **Phase 0 closed.** Admin subtitle canonical = "Add and remove instructors, manage access, and create or duplicate new courses." (drop Instructor/D variant). All 15 audit open questions + registry/nav reconciliation (§9-A) resolved; **B1** analytics deferred for team finalization. Ready for Phase 1. |
| 2026-07-20 | UI cleanup (build feedback): **drop the `Quicklink?` header placeholder** — it never had a defined target, so it's removed from the design, not merely deferred. **Remove the `Undo` button** from the instructor/admin detail-pane footer: the frame's `Delete · Undo · Save changes` becomes **`Delete · Save changes`** (save-only). Neither was implemented in the rebuild; steering + the Phase 0 audit are updated to match. |
| 2026-07-20 | **Opened backend tracks B4 + B2** and finished the admin detail panes against the mockups. **B4:** `Enrolments.access_enabled` (idempotent migration, default TRUE) + `POST /admin/updateInstructorAccess`; the flag is returned on `courseInstructors`/`instructorCourses`. **B2:** `POST /admin/duplicate_course` clones the course + concept/module **outline** only (metadata via `INSERT…SELECT`; not files/embeddings/enrolments/student data). Added `DELETE /admin/unenroll_instructor` (single-pair removal) so per-row add/remove don't reset sibling access flags. **Frontend:** CourseDetail + InstructorDetail rebuilt to the frames — course Active/Inactive toggle in the header, access code on the meta line, assigned lists with per-row Remove + per-instructor/per-course OCELIA-access toggle (optimistic) + an Add picker, and a Delete · Duplicate footer. **Footer is save-only:** all edits persist immediately (matching the existing course-access toggle), so there is no batched "Save changes" button. Instructor position/department + Teaching/On-leave status stay omitted (no backing data). Full stack tested (19 CDK + admin Vitest; suite green). |
| 2026-07-20 | **Design-fidelity correction pass + Option C course-card progress.** Build feedback flagged the rebuild diverging from the frames; corrected against the Figma components as source of truth: **low-radius system** (controls square, containers 4px — the old 6/8/12px over-rounded everything), `--border` → **#808080** (+ `--border-subtle` #BFBFBF), **flat cards** + **hard offset** modal/menu shadow, added `--primary-subtle` + `neutral-*` scale. **Header now shows the account email** (`AuthContext` read the Cognito *access* token, which lacks `email`, so it showed the username UUID → now merges *ID-token* claims). **Create/Edit module are centered modals** over Configuration (nested routes → `ConfigurationTab` `<Outlet/>`), `Tag` → purple-outline pill, `FileUpload` → single click/drag dropzone. **Course-card progress = Option C, backend track B7:** new batched `GET /student/progress_summary` (one SQL aggregate, concept complete when active modules average 100) replaces the per-card `course_page` fetch; `useCourseProgressSummary` (disabled in instructor-preview) + `CourseProgressSummarySchema`; `StudentCourseCard` back to presentational. Tested: CDK OpenAPI-contract + handler unit (200/400/404/401); FE suite green (261). Full CDK Jest suite (Docker) not run — change is YAML + handler + test only. |
