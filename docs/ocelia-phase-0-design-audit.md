# OCELIA Interface Rebuild — Phase 0: Design Audit & Punch-List

**Status:** Complete — Phase 0 closed, all open questions resolved · **Date:** 2026-07-17
**Owner:** Frontend rebuild · **Parent:** `docs/ocelia-interface-rebuild-plan.md` (§13 Phase 0)
**Design source:** Figma `OCELIA - May 2026` — file key `9Kt3RPFlZalJnPtCuHLObU`, page `0:1`.
Page `846:6698` (`Inspo + draft work`) holds inspiration + the deferred mobile student set — **out of scope**.

> **Purpose.** Inventory every in-scope screen, map it to components, catalogue every missing state,
> draft the navigation/route map, inventory interactive states, and log every inconsistency so it can be
> resolved with the stakeholder **before** building begins (Phase 1+). This is the punch-list Phase 0 exits on.

## Method

- **Structure** — full frame tree pulled via `get_metadata` on page `0:1` (all node IDs below are from that pull).
- **Tokens** — `get_variable_defs` on a token-rich instructor screen (`771:5650`).
- **Visual** — screenshots reviewed for a representative screen from three of the four sets (Student Home
  `143:1171`, Student Module reference-doc `209:5164`, Instructor Configuration `365:2504`); remaining
  screens read from metadata + component definitions.
- **Current app** — `App.jsx`, `main.jsx`, `Theme.jsx`, `package.json`, and the `src/pages|components|context|services` tree.

> Screenshot coverage is representative, not exhaustive. Before each build slice (Phase 5–7) the specific
> screens for that slice should be re-pulled at full fidelity. Nothing here blocks on the un-screenshotted
> screens: their structure is known from metadata and their inconsistencies are logged below.

---

## 1. Executive summary — top findings

1. **Nav model mismatch with the registry.** OCELIA uses a **top Header + (instructor) a top tab bar**, not
   the left `AppSidebar` the current `ui-component-registry.md` assumes. The registry and
   `frontend-conventions` navigation section need reconciling (see §4, §9-A). **Approved (§9-A) — reconcile in Phase 1.**
2. **Two nav items have no designed screens.** The instructor has **two nav levels**: a top nav in the
   `Header/Instructor` component (`Courses | Global Analytics | Global Chats` + a placeholder `Quicklink?`
   button), and the **in-course sub-tabs** `Configuration | Insights | Chat history | Settings | Students`.
   The sub-tabs are fully designed; the top-nav `Global Analytics` and `Global Chats` (and `Quicklink?`)
   have **no frames**. **Resolved (OQ-5):** keep `Global Analytics` + `Global Chats` as nav items routing to
   **placeholder stub pages** ("coming soon"); **omit `Quicklink?`** from the initial build until its action is defined.
3. **Join-code copy contradicts the real code.** Modals say "6-digit code"; the access code rendered in
   config/add-course is long alphanumeric (`65XH19000jo12`, `88dfs629IIPd`). Plan already decided: keep the
   16-char code, fix the copy (backend track B3). See OQ-1.
4. **Insights simplified (resolved 2026-07-17).** The mockup's Insights tab shows a 3-metric switcher over
   **static screenshot** charts. For now the tab **ports the current app's analytics chart** only
   (`instructor/analytics`); the multi-metric switcher, tag filters, Clear data, and Export are **removed**,
   and engagement/reach/clear-data (**B1**) are **deferred** for team finalization. See OQ-6.
4a. **Chat History = the student chat-logs table (requirement change).** The *Chat History* tab's
   `Table/Desktop` (`437:8490`) columns are `User · Module name · Concept · Session ID · Message · Label ×3`
   (drawn at 30% opacity = empty/pre-generation state) — i.e. the fields of the **student chat-logs CSV** the
   instructor generates today (`ChatLogs.jsx` → `POST instructor/course_messages` async job →
   `GET instructor/fetch_chatlogs` returns per-file presigned CSV URLs). **New requirement:** render that CSV
   **in an in-app table** and offer **CSV *and* Excel** download. This needs (a) chat-log rows as JSON for the
   table (today only CSV files exist → backend track **B5**) and (b) an **Excel/xlsx** path — **resolved as
   server-side `.xlsx`** (B5; now recorded in plan §6/§12/§13). See OQ-15 *(resolved)*.
5. **Token taxonomy is incomplete in the plan.** The design binds **Yellow/warning `#A88F00`** and **Red
   Secondary `#FFE6E6`**, which plan §8 omits. Only `Body - Desktop` is a bound *variable*; the type scale
   (H2/H4) appears to be text styles, so Phase 1 must define those tokens explicitly. See §8, OQ-8/OQ-9.
6. **No empty / loading / error / responsive states are drawn** (beyond prompt-conflict alerts, the
   wizard/prompt spinners, and file-upload progress). These must be defined from tokens, per plan §10. See §6.
7. **Module edit model (resolved 2026-07-17).** Configuration is a **Concept (1) → Modules (many)** tree.
   Concepts support **inline edit** (the row pencil), **add**, and **delete** — and **deleting a concept
   cascade-deletes its modules**. Concepts + modules are **drag-and-drop reorderable** (`@dnd-kit`). **Expanding** a module shows a
   read-only summary + **Edit** / **Delete module**; **Edit** opens `Modal/EditModule` — a **single-page**
   form with **all** module fields editable. The Figma expanded variant (`Configuration/Module` Variant2)
   currently shows inline-editable fields + no Edit button; it is reconciled to summary+Edit. See OQ-3/OQ-4.
8. **Heavy frame duplication.** Settings has 10+ near-identical frames including **two both named
   `Settings/H`**; Configuration is numbered 1–6 with a nested "4b" and gaps. Canonical states **resolved** — see OQ-2 (Settings) / OQ-3 (Configuration).

All screens for the first two slices (**Student, Instructor**) are inventoried with their states below; no
unknown states remain for them (Phase 0 exit criterion). Remaining open items are **decisions**, not unknowns,
and are collected in §9.

---

## 2. Screen inventory

Route column is the **proposed** target (see §7). "States present" = distinct frames/variants found.

### 2.1 Student set

| Screen | Node(s) | Purpose | Proposed route | States present |
|---|---|---|---|---|
| Home (course grid) | `143:1171` | 3×2 `Card/Course` grid, Join-course CTA | `/courses` | Populated only |
| Course view — collapsed | `143:1427` | Concept list collapsed + Learning Journey drawer | `/courses/:courseId` | Collapsed |
| Course view — expanded | `151:3297` | Concepts expanded (module rows visible) | `/courses/:courseId?expand=1` | Expanded |
| Module chat — intro | `162:3817` | Sidebar + intro assistant message | `/courses/:courseId/modules/:moduleId` | Intro |
| Module chat — mid-conversation | `214:5316` | Q&A thread (assistant + student bubbles) | (same) | Active convo |
| Module chat — expanded | `214:5499` | Chat area expanded (concept header hidden) | (same, `?expand=1`) | Expanded |
| Module chat — slide-in | `221:6191` | "Slide In" materials drawer open | (same) | Drawer open |
| Module chat — B / C | `209:4781`, `209:5056` | Breadcrumb w/ course code; expand/collapse combos | (same) | Variants |
| Module chat — reference doc | `209:5164` | **3-column**: sidebar · doc viewer · chat | (same, `?doc=:fileId`) | Doc open |

Shared student chrome: `Header` (Student variant), breadcrumb `‹ COURSES`, global `Expand ⌄`, `Learning Journey drawer`.

### 2.2 Admin set

| Screen | Node(s) | Purpose | Proposed route | States present |
|---|---|---|---|---|
| Instructor management — list | `266:1435` | `List/Instructor` + search | `/admin/instructors` | List |
| Instructor management — detail | `275:3336`, `283:3612`, `352:2128` | Profile, assigned courses, OCELIA-access toggles, delete/remove | `/admin/instructors/:instructorId` | 3 near-dup detail variants |
| Course management — list | `293:3948` | `List/Course/Admin` + search | `/admin/courses` | List |
| Course management — detail | `293:4245` | `Profile/Course`, instructors, OCELIA-access toggles | `/admin/courses/:courseId` | Detail |

`352:2128` (Instructor/D) uses a **different page subtitle** than A/B/C — resolved to the A/B/C wording (OQ-14).

### 2.3 Instructor set

| Screen | Node(s) | Purpose | Proposed route | States present |
|---|---|---|---|---|
| Courses list | `360:2265` | `List/Course/Instructor` + search | `/instructor/courses` | List |
| Course ▸ Configuration | `365:2504`, `433:6296/6487/6676/6872`, `437:7270` | Concept/module tree, inline edit, add concept/module | `/instructor/courses/:courseId/configuration` | 6 frames (collapsed; +nested "4b"/overlay) |
| Course ▸ Insights | `376:2182` etc. | **Port current `instructor/analytics` chart** (messages/module + per-module stats), restyled. Metric switcher / tag filters / Clear data / Export **removed**; engagement + reach **deferred (B1)** | `/instructor/courses/:courseId/insights` | Current chart only |
| Course ▸ Settings | `376:2480`,`771:6727`,`771:5650`,`771:5958`,`777:7223`,`771:6541`,`771:6193`,`777:7390`,`826:6510`,`771:6374` | Model dropdown, read-only system prompt, editable prompt, conflict UI, view-previous, save (spinner) | `/instructor/courses/:courseId/settings` | 10 near-dup frames (incl. dup `H`) |
| Course ▸ Chat history | `376:2331` (table `437:8490`) | **Student chat-logs table** (User · Module · Concept · Session ID · Message · Label ×3) + generate + **CSV/Excel export**; row-select checkboxes | `/instructor/courses/:courseId/chat-history` | Table (drawn dimmed = empty/pre-gen) |
| Course ▸ Students | `376:2525` | `Instructor/List/Student` roster + search | `/instructor/courses/:courseId/students` | List |
| Global Analytics | **none** | Top-nav item → **placeholder stub** for now | `/instructor/analytics` | Placeholder "coming soon" (OQ-5) |
| Global Chats | **none** | Top-nav item → **placeholder stub** for now | `/instructor/chats` | Placeholder "coming soon" (OQ-5) |

Shared instructor chrome: `Header` (Instructor) + `Header/Instructor` tab bar (Default = tabs, Variant2 = collapsed),
`Profile/Course`, the 5 sub-tabs, and the `Delete course · Undo · Save changes` footer.

### 2.4 Module wizard, edit & view

| Flow | Node(s) | Purpose | Surface |
|---|---|---|---|
| Create — Step 1 (name/concept) | `734:5404` | Module name + concept select | Modal wizard |
| Create — Step 2 (references) | `743:5593`, `748:5940` (drag), `746:5693` (uploaded) | Attach refs + upload files | Modal wizard |
| Create — Step 3 (prompt + topics) | `758:6005`, `769:5563` (filled), `777:6988` (generating/spinner), `769:5629` (conflict alert) | Module prompt + auto key topics | Modal wizard |
| Create — Step 4 (review) | `807:7477` | Read-only summary + Confirm | Modal wizard |
| Edit | `859:7574` (`Modal/EditModule`) | **Single-page** form, **all** module fields editable (wizard fields, not stepped) | Modal (opened from the expanded row's `Edit`) |
| View (expand) | `859:7413` (`Configuration/Module` Variant2) | **Read-only summary** on expand + `Edit` / `Delete module` (reconciled from the inline-editable Figma variant) | In-place in the Configuration tree |

---

## 3. Design-set → set-level layout notes

- **Student** — top `Header` (UBC crest + OCELIA wordmark + account). Home = max-width grid, 3 columns.
  Course = concept accordion + Learning Journey drawer. Module = 2-column (sidebar + chat), expanding to
  3-column when a reference doc is opened. Chat sidebar carries **Previous chats** and a **Module materials**
  file list (the `Slide In` component).
- **Admin & Instructor** — **master-detail**: left search + list, right detail. Instructor adds a top tab
  bar (`Courses / Global Analytics / Global Chats`) and, inside a course, 5 sub-tabs. Both use `Profile` /
  `Profile/Course` headers and a shared destructive-action footer.
- **Wizard** — centered modal, progress bar + step title, `Back` / `Cancel` / `Next|Confirm` footer,
  determinate step states (upload progress, topic-generation spinner).

---

## 4. Reusable-component map (Figma → target)

Target tiers per `frontend-conventions` (`ui/` primitives · `composed/` · `features/`). "Registry?" flags
whether the name exists in `ui-component-registry.md` today.

### 4.1 Primitives (`src/components/ui/`)

| Figma | Target primitive | Registry? | Notes |
|---|---|---|---|
| `Button/UI/*`, `Button/CTA/*`, `Button/UI`, `Button/Spinner` | `Button` (variants) | Partial | **Two families (UI + CTA) × Primary/Secondary/Tertiary + with-icon + spinner**; registry variants (`default/secondary/outline/ghost/danger`) don't map — reconcile (OQ-A). |
| `Searchbar/Desktop/UI Search` | `Input` (+ composed `Searchbar`) | Yes (`Input`) | |
| prompt text areas | `Textarea` | Yes | Char counter (`446/1000`) + read-only variant (system prompt). |
| `UI/Chevron/Down` dropdowns, `Language model/Dropdown` | `Select` | Yes | |
| `Card/Course`, `Concept/*` | `Card` | Yes | |
| status pills (`COMPLETED/IN PROGRESS/ACCESS REQUESTED/ACTIVE`), `Tag`, `Tag/Editable` | `Badge` / `Tag` | `Badge` yes; **`Tag` missing** | Add `Tag`/`Toggle` — see §9-A. |
| `Toggle/With Text` | `Toggle` | **Missing** | Add to registry. |
| `Alert`, `Conflict/Ex1/Ex2` | `Alert` | **Missing** | Add; distinct from toast. |
| `Table/Desktop` | `Table` (+ `DataTable`) | Yes | Chat-logs table; virtualize (perf); row-select + CSV/Excel export toolbar (OQ-15). |
| all `Modal/*` | `Dialog` | Yes | 13 modal frames. |
| `Separator/All`, `UI/Pipe`, `Line *` | `Separator` | Yes | |
| `UI` (checkbox Inactive/Hover) | `Checkbox` | **Missing** | Add. |
| assistant/student avatars (polygon/ellipse) | `Avatar` | Yes | |
| wizard/prompt spinners, `Button/Spinner` | `Spinner` + `Skeleton`/`Progress` | `Skeleton`/`Progress` exist | |

### 4.2 Composed (`src/components/composed/`)

| Figma | Target composed | Registry? |
|---|---|---|
| `Card/Course` | `CourseCard` | **Missing (add)** |
| `List/Instructor`, `Instructor/List/Student` | `StudentRow` / `InstructorRow` | Partial |
| `List/Course/Admin`, `List/Course/Instructor` | `CourseRow` | **Missing (add)** |
| `Profile`, `Profile/Course` | `ProfileHeader` | **Missing (add)** |
| `Configuration/Concept|Module|ModuleNew`, `Concept/Parent|Option` | `ModuleAccordion` (config tree + read-only View) | **Missing (add)** |
| `Concept/1–8` | `ConceptAccordion` (student) | **Missing (add)** |
| `Slide In` + `Button/Chat` + Module materials | `ChatSidebar` | **Missing (add)** |
| chat frames (`OCELIA ASSISTANT`, bubbles) | `ChatThread` / `AIMessage` / `StudentMessage` / `TypingIndicator` | Yes |
| reference-doc column (Module/D) | `ReferenceDocPanel` | Partial (current `FileViewerPanel`/`PdfViewerPanel`) |
| `Wizard` (Steps), `Wizard` (Number) | `WizardStepper` | **Missing (add)** |
| `Wizard` (UploadFrame), `Wizard/FileUpload/Status`, `UploadedFile/a|b|c` | `FileUpload` | **Missing (add)** |
| `Language model/Dropdown|Selection` | `LanguageModelDropdown` | **Missing (add)** |
| `Prompt/ViewPrevious`, `Prompt/Previous/1` | `PromptHistory` | **Missing (add)** |
| `Conflict/Ex1|Ex2` | `ConflictList` | **Missing (add)** |
| `Learning Journey drawer` | `LearningJourneyDrawer` | **Missing (add)** — progress tracker; reuse existing `useCourseProgress`/`useModuleProgress` (OQ-12 resolved) |
| Insights charts | `AnalyticsChart` (Recharts) | Partial (`StatCard`) |
| `Header`, `Header/Instructor` | `AppHeader` + `InstructorTabBar` | **Registry has `AppSidebar` instead (OQ-A)** |

### 4.3 Feature areas (`src/features/`)
`StudentChat` · `CourseWizard` · `ModuleEditor` · `AnalyticsGraph` · `PromptSettings` · `RosterManagement` ·
`CourseManagement` (admin) · `InstructorManagement` (admin).

> **Registry outcome:** ~15 composed components + `Toggle`/`Tag`/`Alert`/`Checkbox` primitives are **not yet in
> `ui-component-registry.md`**, and the nav model is sidebar-based there vs. top-nav in the design. Registry +
> `frontend-conventions` nav section must be updated in **Phase 1** (before Phase 4 build). Logged as §9-A.

---

## 5. Interactive-element state inventory

Per plan §9, every interactive element ships the full set:
`default · hover · focus-visible · active/pressed · disabled · loading · selected · error · read-only` (as applicable).

| Component | States **drawn** in Figma | States **to define** from tokens (not drawn) |
|---|---|---|
| `Card/Course` | Default, Hover, Clicked, Inactive | focus-visible, loading (skeleton) |
| `Button` (UI + CTA) | Hover, Inactive(=disabled), Spinner(=loading) | focus-visible, active/pressed (explicit) |
| `Button/Chat` | Default, +2 variants (hover/active) | focus-visible, selected |
| List rows (`List/Instructor`, `List/Course/*`) | Default, Variant2, Variant3 (default/hover/selected likely) | focus-visible, disabled, loading |
| `Tag/Editable` | Dismissable + 4 variants | focus-visible, error (invalid topic) |
| `Toggle/With Text` | Inactive, Active | focus-visible, disabled |
| `UI` checkbox | Inactive, Hover | checked, focus-visible, disabled |
| `Slide In` | Default, Variant2, Variant3 | focus-visible |
| `Wizard` stepper | Inactive, Current, Link | — |
| `Wizard/FileUpload/Status` | InProgress, Error, Success | idle/empty (drop target default) |
| inputs / `Searchbar` / `Textarea` | default only | hover, focus-visible, error/invalid, disabled, read-only |
| `Header/Instructor` tabs & sub-tabs | active vs. inactive (underline) | hover, focus-visible, disabled |
| `Language model/Dropdown` | Default, open (Variant2) | focus-visible, disabled |

**Cross-cutting gaps (define as token-based defaults in Phase 4):**
- **focus-visible is not drawn on any component** — must derive from `--ring` for full keyboard parity (a11y DoD).
- **Per-field input error** state is undrawn (only prompt-level `Alert`/`Conflict` exist).
- **active/pressed** only implied (`Card` "Clicked"); standardize a pressed treatment.
- **read-only** exists conceptually (system prompt) but not as an input state.

---

## 6. Missing states (empty / loading / error / responsive)

| Category | Drawn? | Gaps to design as token-based defaults (plan §10) |
|---|---|---|
| **Empty** | No | Student: no-courses grid, no previous-chats. Instructor: empty course list, empty roster, empty chat-history, empty insights. Admin: empty instructor/course lists. **Search "no results"** for every `Searchbar`. Use `EmptyState`. |
| **Loading** | Partial | Drawn: wizard topic-gen spinner (`777:6988`), prompt-save spinner (`771:6727/6541`), file-upload progress. **Missing:** skeletons for grid/list/table/detail loads, chat typing indicator (exists in code, not mockup), initial route Suspense fallbacks. |
| **Error** | Partial | Drawn: prompt `Alert` + `Conflict`. **Missing:** generic failed-load/retry (registry `RetryBanner` not in mockup), chat-response failure, 403 "no access", 404 not-found, offline banner, upload-failed recovery (only `Error` status pill). |
| **Responsive** | No | All frames are **1440px desktop only**. No tablet frames (mobile deferred to Inspo page). The **tablet floor** (plan: "tablet-safe") is undefined — define breakpoint behavior for the nav shell, master-detail (stack), 3-column module (collapse doc panel), and course grid (3→2→1). |

---

## 7. Navigation / route map (draft)

**Principles (plan §9):** resource IDs in the URL, every screen deep-linkable + refresh-safe, no dead ends,
404 + legacy redirects, role guards.

```
/login
/                         -> redirect by role to /courses | /instructor/courses | /admin/...
STUDENT
  /courses                                            Home (grid)
  /courses/:courseId                                  Course (concepts; ?expand=1)
  /courses/:courseId/modules/:moduleId                Module chat (?doc=:fileId opens reference panel)
  /courses/:courseId/modules/:moduleId/chats/:sessionId  (optional: deep-link a past chat)
INSTRUCTOR
  /instructor/courses                                 Courses list
  /instructor/courses/:courseId/configuration         (default tab)
  /instructor/courses/:courseId/insights
  /instructor/courses/:courseId/chat-history
  /instructor/courses/:courseId/settings
  /instructor/courses/:courseId/students
  /instructor/courses/:courseId/modules/new           Create wizard (modal over Configuration)
  /instructor/courses/:courseId/modules/:moduleId/edit Edit modal
  /instructor/analytics                               Global Analytics  ** NO DESIGN (OQ-5) **
  /instructor/chats                                   Global Chats      ** NO DESIGN (OQ-5) **
ADMIN
  /admin/instructors                                  List
  /admin/instructors/:instructorId                    Detail
  /admin/courses                                       List
  /admin/courses/:courseId                             Detail
*  -> 404 (with back-to-home)
```

**Legacy redirects (from current app):**

| Current | Redirect to |
|---|---|
| `/#/…` (hash) | strip hash; Amplify SPA rewrite serves `index.html` |
| `/home/*` | role home |
| `/student_course/*` (course in App state) | `/courses/:courseId` |
| `/student_chat/*` (course+module in App state) | `/courses/:courseId/modules/:moduleId` |
| `/course/*` (renders InstructorHomepage) | `/instructor/courses` |

### Current dead-ends / illogical routes catalogued (for Phase 2 redesign)

1. **Hash vs. BrowserRouter mismatch** — `package.json` `homepage` ends `/#/`; app uses `BrowserRouter`. No Amplify SPA rewrite → deep links / refresh 404.
2. **Context lost on refresh** — `course` and `module` live in `App.jsx` `useState` and are passed as props to `StudentChat`/`CourseView`. Refreshing `/student_chat` or linking to it loses the course/module → blank/broken screen (the primary dead-end).
3. **ID-less wildcard routes** — `/student_chat/*`, `/student_course/*` carry no resource IDs.
4. **`getHomePage()` switch** — role routing via a render switch, not nested routes/guards; the "instructor-as-student" toggle rides `UserContext`.
5. **Duplicate instructor entry** — `/course/*` and `/home/*` both render `InstructorHomepage`.
6. **No 404 route** and no not-found/redirect handling.

---

## 8. Design-token findings (delta vs. plan §8)

Bound variables observed (`get_variable_defs` @ `771:5650`):

| Figma variable | Value | In plan §8? |
|---|---|---|
| `UBC/Primary` | `#002145` | Yes (navy) |
| `Faculty of Arts/Primary` | `#6829C2` | Yes (primary) |
| `Arts ISIT Neutral/*` | `#000 · #404040 · #808080 · #BFBFBF · #FFF` | Yes |
| `Arts ISIT Alerts/Green Primary` | `#11A26F` | Yes (success) |
| `Arts ISIT Alerts/Red Primary` | `#E40000` | Yes (destructive) |
| `Arts ISIT Alerts/Red Secondary` | `#FFE6E6` | **No — add (subtle destructive bg)** |
| `Arts ISIT Alerts/Yellow Primary` | `#A88F00` | **No — add (warning)** |
| `Body - Desktop` | Whitney, Book, 18/28, weight **325** | Yes (body) |

**Findings:**
- **Add `warning` (`#A88F00`) and a subtle-destructive/`destructive-muted` (`#FFE6E6`) semantic token** in Phase 1 —
  they're used by `Alert`/`Conflict`/prompt warnings.
- **Accent cyan `#6EC4E8`** (plan §8) is the **"IN PROGRESS"** status color — confirm it as its own semantic
  token (`info`/`in-progress`) rather than folding into primary.
- **Type scale is not fully tokenized** — only `Body - Desktop` came back as a bound variable; H2 (34/46) and
  H4 (18/28 semibold) appear to be **text styles**, not variables. Phase 1 must define the full size/line-height/weight scale as tokens.
- **Non-standard Whitney weights** (Book ≈ 325, Semibold ≈ 375) don't exist in Inter — **mapped Book → Inter 400, Semibold → Inter 600** (OQ-11 resolved).
- **Not yet captured** (confirm during Phase 1 token build): spacing scale, radius, **shadow (`card/modal/dropdown`)**,
  motion, z-index. Plan §8 already flags these as "confirmed during the design audit" — they are **not bound
  Figma variables**, so they must be read off the frames and codified. Flagged for Phase 1.

---

## 9. Inconsistencies & open questions (stakeholder decisions)

Phase 0 exits only when these are **resolved with the stakeholder**. Each has a proposed resolution; items
marked *(plan)* are already decided in the rebuild plan and just need confirmation.

| # | Issue | Proposed resolution | Owner/track |
|---|---|---|---|
| **A** *(approved 2026-07-17)* | Registry assumes left `AppSidebar`; design is **top Header + instructor tab bar**. ~15 composed + `Toggle/Tag/Alert/Checkbox` primitives missing from registry. | **Approved:** update `ui-component-registry.md` + `frontend-conventions` nav section in **Phase 1** (retire the `AppSidebar` assumption → top-nav model; add the missing primitives + composed components) before Phase 4 builds them. | Phase 1 |
| **OQ-1** *(resolved 2026-07-17)* | "6-digit code" copy vs. 16-char alphanumeric access code shown. | **Confirmed:** keep the **16-char** code; reword the Join/Assign modal + help copy away from "6-digit". *(plan B3)* | B3 |
| **OQ-2** *(resolved 2026-07-17)* | 10+ Settings frames = one screen in states; two `Settings/H`; a manual `Check for conflicts` button. | **Confirmed:** collapse to one Settings screen. **Conflict UX:** drop `Check for conflicts` — run the check **on Save**. On conflict → **block the save + show the conflict list** (`Save` stays enabled, prompt unsaved). **Re-clicking `Save` with the conflicts unaddressed → warning confirm modal → save anyway (override)**; editing the prompt re-checks on the next Save. Uses existing `validate_prompt` + prompt save (frontend orchestration; no backend gap). Needs a "save with unresolved conflicts?" confirm modal (not yet drawn). The Settings-tab **dot = unresolved-prompt-conflict indicator** (driven by stored `conflict_metadata`); it persists after an override-save until the prompt is edited conflict-free — **not** an unsaved-changes dot. | Phase 6 |
| **OQ-3** *(resolved 2026-07-17)* | Configuration numbered 1–6 with nested "4b" + `OVERLAY/Concept` and gaps. | **Confirmed:** one **Concept→Module tree** (1:many). Concepts support **inline edit** (row pencil) + **add** + **delete**; **deleting a concept cascade-deletes its modules** — needs a destructive "Delete concept?" confirm naming affected modules (not in the current modal set). **Backend check (2026-07-17):** the DB **already cascades rows** (concept→modules→`Module_Files`/`Student_Modules`/`Sessions`/`Messages` via `ON DELETE CASCADE`), **but S3 files + pgvector embeddings are NOT cleaned up**, and since the rows are hard-deleted `orphanCleanup` can't catch them → **permanent orphans**. **Gap B6 (mark-and-sweep):** `delete_concept` marks its modules `status='deleting'` + triggers async cleanup (embeddings + S3 + rows via `orphanCleanup.cleanup_module`) and returns fast; the concept row is deleted only after its modules are swept (so the cascade can't hard-delete them first); `orphanCleanup` stays as the backstop. **Drag-and-drop reorder** of concepts + modules is **in scope** (adds `@dnd-kit`; keyboard-accessible per a11y DoD) — `OVERLAY/Concept` is the drag ghost. Canonical states: collapsed · concept-expanded · module-expanded (summary) · adding concept/module · reordering (drag) · dirty (Undo/Save). | Phase 6 |
| **OQ-4** *(resolved 2026-07-17)* | Figma's expanded module (`Configuration/Module` Variant2) shows inline-editable fields + no Edit button; the plan called it a read-only "View" → two conflicting edit surfaces. | **Confirmed one model:** expand = **read-only summary** + `Edit` / `Delete module`; `Edit` opens **`Modal/EditModule`** = single-page, all-fields editable (wizard fields, not stepped). No inline editing in the tree. An optional read-only expand (no `Edit`) covers view-only roles (e.g. TA). | Phase 6 |
| **OQ-5** *(resolved 2026-07-17)* | **Global Analytics** & **Global Chats** top-nav items (+ `Quicklink?`) have **no frames**. | **Keep** `Global Analytics` + `Global Chats` as nav items → **placeholder stub pages** ("coming soon" / empty-state) for now (dead links, not fully-designed features). **`Quicklink?` omitted** from the initial build until its action/target is defined. | Phase 6 |
| **OQ-6** *(resolved 2026-07-17)* | Insights charts are **static screenshot images**; frame shows a 3-metric switcher (Messages / Student Engagement / Content Metrics) + tag filters + Clear data + Export. | **Simplified for now:** Insights **ports the current app's analytics chart** (`instructor/analytics`: messages-per-module + per-module completion/message/access stats), restyled to tokens. **Remove** the 3-metric switcher, tag filters, **Clear data**, and **Export**. Engagement-over-time + content-reach + clear-data (**B1**) **deferred** pending team finalization. | Phase 6 (B1 deferred) |
| **OQ-7** *(resolved 2026-07-17)* | OCELIA-access `Toggle` (admin) + `Inactive/Active` course toggle (instructor Config header) — backend mapping + semantics unclear. | **Confirmed (two distinct concepts):** course **Active/Inactive** → existing `Courses.course_student_access` (no backend change); **per-instructor "OCELIA access"** → **new `Enrolments.access_enabled` column** (B4, in scope). | B4 |
| **OQ-8** *(resolved 2026-07-17)* | `Yellow #A88F00` + `Red Secondary #FFE6E6` used but absent from plan token table. | **Confirmed — add all three:** `warning` (`#A88F00`), `destructive-muted` (`#FFE6E6`), and `info`/`in-progress` (accent cyan `#6EC4E8`). | Phase 1 |
| **OQ-9** *(resolved 2026-07-17)* | Type scale not tokenized (only Body bound); H2/H4 are text styles. | **Confirmed:** codify the **full** type scale as tokens in Phase 1 (H2 34/46, H4 18/28 semibold, Body 18/28 book + caption/label sizes). | Phase 1 |
| **OQ-10** *(resolved 2026-07-17)* | Student Home shows unresolved placeholder **"Global COURSE FILES for students HERE?"** | **Cut for now** — drop the placeholder; no course-wide student files area in this rebuild. | — |
| **OQ-11** *(resolved 2026-07-17)* | Whitney weights 325/375 have no Inter equivalent. | **Confirmed:** map Whitney **Book → Inter 400**, **Semibold → Inter 600**; keep the one-line `@font-face` swap point when Whitney is licensed. | Phase 1 |
| **OQ-12** *(resolved 2026-07-17)* | `Learning Journey drawer` purpose/behavior unspecified. | **Confirmed:** it's the **progress tracker** and **already exists** in the current app (`useCourseProgress` / `useModuleProgress`); the new design changes it little — **port existing behavior**, restyle to tokens. | Phase 5 |
| **OQ-13** *(resolved 2026-07-17)* | Student Module has A/Alt1-3 + B/C/D — overlap between "expand", "slide-in", and "reference-doc". | **Confirmed canonical states:** intro · mid-conversation (active) · expanded · slide-in materials drawer · reference-doc panel. | Phase 5 |
| **OQ-14** *(resolved 2026-07-17)* | Admin Instructor/D subtitle copy differs from A/B/C. | **Confirmed:** canonical subtitle = *"Add and remove instructors, manage access, and create or duplicate new courses."* (5-frame majority); drop the Instructor/D variant. | Phase 7 |
| **OQ-15** *(resolved 2026-07-17)* | Chat-logs must render **in-app as a table** (Chat History tab) + download **CSV and Excel**. Today only presigned CSV files exist; no row-JSON endpoint; no xlsx. | **Confirmed:** table lives in **Chat History**; Excel is **server-side `.xlsx`** (not client-side SheetJS). Added backend track **B5** (rows-as-JSON + server-side xlsx, extending `course_messages`; CSV unchanged). Plan §6/§12/§13 + decision log updated. | B5 (Phase 6) |

---

## 10. Current → target file mapping (for the strangler migration)

| Current (MUI) | Target area | Phase |
|---|---|---|
| `pages/student/StudentHomepage.jsx` | `features/student` + `/courses` route | 5 |
| `pages/student/CourseView.jsx` | `/courses/:courseId` | 5 |
| `pages/student/StudentChat.jsx` (+ `useChatSession`, `TypingIndicator`) | `features/StudentChat` | 5 |
| `pages/instructor/*` (14 files: Concepts/Modules/Prompt CRUD, Analytics, ChatLogs, ViewStudents, Sidebar…) | `features/{ModuleEditor,CourseWizard,PromptSettings,AnalyticsGraph,RosterManagement}` + instructor routes | 6 |
| `pages/admin/*` (Courses, CreateCourse, Instructors, details, Sidebar) | `features/{CourseManagement,InstructorManagement}` + admin routes | 7 |
| `components/{AdminHeader,InstructorHeader,StudentHeader}.jsx` | `AppHeader` + `InstructorTabBar` | 2/4 |
| `components/{FileViewerPanel,PdfViewerPanel,FileManagement,FileProgressRow}.jsx` | `ReferenceDocPanel` + `FileUpload` | 5/6 |
| `components/{AIMessage,StudentMessage,Session}.jsx` | `composed` chat components | 5 |
| `Theme.jsx` + `main.jsx` MUI `ThemeProvider` | **delete** (tokens replace) | 8 |
| `context/NotificationContext.jsx` | keep; **add** `AuthContext`, `CourseContext` | 2 |
| `services/api.js` | keep client; **add** TanStack Query hooks + Zod | 3 |
| `components/ui/{progress,skeleton}.jsx` | keep; add the rest of the primitives | 4 |

**Dependencies to add** (currently absent): `@tanstack/react-query`, `react-hook-form`, `zod`, `vitest`,
`@testing-library/react`, `@playwright/test`, and a per-icon Material Symbols source. **To remove in Phase 8:**
`@mui/material`, `@mui/icons-material`, `@emotion/*`, `material-react-table`, `lucide-react`.

---

## 11. Phase 0 exit-criteria check

| Exit criterion (plan §13) | Status |
|---|---|
| Every in-scope screen inventoried & mapped to components | ✅ §2, §4 |
| Every missing state (empty/loading/error/interaction/responsive) documented | ✅ §5, §6 |
| All inconsistencies logged **and resolved with stakeholder** | ✅ Logged (§9); **all 15 + §9-A resolved (2026-07-17)** |
| No unknown states remain for the first two slices (Student, Instructor) | ✅ §2.1, §2.3, §5 |
| Navigation/route map drafted; current dead-ends catalogued | ✅ §7 |
| Interactive-element states inventoried per component | ✅ §5 |

**Phase 0 closed (2026-07-17).** All 15 open questions + the registry/nav reconciliation (§9-A) are resolved
(see §9 + the plan decision log). Deferred by decision, pending team finalization: **B1** analytics
(engagement / reach / clear-data) and the `Quicklink?` header button. **Phase 1** (tokens/fonts/icons + the
registry/steering reconciliation) is ready to start; backend tracks **B2–B6** run in parallel.

---

## 12. Appendix — component library node index

Header `859:7184` · Header/Instructor `859:7380` · Card/Course `859:6653` · Concept/1–8 `859:6283…6540` ·
Learning Journey drawer `859:6554` · Tag `859:6648` · Tag/Editable `859:7551` · Button/Chat `859:6765` ·
Slide In `859:6717` · UI(checkbox) `859:6710` · List/Instructor `859:7281` · List/Course/Admin `859:7301` ·
List/Course/Instructor `859:7329` · Profile `859:7357` · Profile/Course `859:7297` ·
Instructor/List/Student `859:7379` · Configuration/Concept `859:7412` · Configuration/Module `859:7413` ·
Configuration/ModuleNew `859:7469` · Concept/Option `859:7509` · Concept/Parent `859:7514` ·
Language model/Selection `859:7532` · Language model/Dropdown `859:7539` · Wizard(steps) `859:7640` ·
Wizard(number) `859:7645` · Wizard/FileUpload/Status `859:7652` · Button/Spinner `859:7663` ·
UploadedFile a/b/c `859:7676/7702/7753` · Wizard(upload) `859:7786` · Conflict/Ex1 `859:7797` ·
Conflict/Ex2 `859:7814` · Prompt/ViewPrevious `859:7831` · Prompt/Previous/1 `859:7852` · Alert `859:7862` ·
Overlay/Review/Upload `859:7869`.
Modals: Join `859:6784` · Assign `859:6805` · Discard `859:6825` · Add Instructor `859:6842` ·
Add Course/A `859:6864` · Duplicate/C `859:6928` · Add+Duplicate/B1 `859:6997` · Save Changes `859:7096` ·
Delete Instructor `859:7116` · Remove Instructor `859:7133` · Delete Course `859:7150` · Remove Course `859:7167`.
