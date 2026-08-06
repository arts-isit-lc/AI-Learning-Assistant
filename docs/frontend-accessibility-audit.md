# Frontend Accessibility Audit — OCELIA

**Date:** 2026-08-05
**Scope:** `frontend/` — the OCELIA React 18 + Vite + Tailwind/shadcn SPA (all roles: student, instructor, admin).
**Type:** Static analysis + manual code review + computed contrast. No runtime assistive-technology (AT) testing.
**Target:** WCAG 2.1/2.2 Level AA.

---

## Bottom line

This is a genuinely accessibility-aware codebase, well above the norm. The automated `jsx-a11y` scan is completely clean (0 violations), the shadcn/Radix primitives are used correctly, and there's clear intent throughout (live regions, labeled icon buttons, keyboard-reachable controls). The gaps that remain are mostly at the seams static tooling can't see: a few real color-contrast failures, SPA page-title/navigation semantics, and consistency issues. Nothing is catastrophic, but a handful of items are worth fixing.

## Methodology & caveats

- **ESLint** (`eslint-plugin-jsx-a11y`, recommended ruleset) run across the whole `src/` tree.
- **Manual review** of foundational layer (entry point, tokens, icon wrapper, layouts) and every critical flow (auth/login, student chat + streaming, course join, module create/edit, admin CRUD, data tables, charts, dialogs, file upload).
- **Contrast** computed with the WCAG relative-luminance formula against the design tokens in `frontend/src/index.css`.
- **Caveats:**
  - This is **static analysis**. It cannot confirm actual screen-reader output, focus order at runtime, or keyboard traps. Real testing with NVDA / VoiceOver / keyboard-only is still required (see "Needs manual AT testing").
  - Tooling note: the workspace `grep_search` (ripgrep) was unavailable during this audit; findings were gathered with `grep`/ESLint via the shell.

---

## Summary of findings

| # | Severity | Finding | WCAG | Primary location |
|---|----------|---------|------|------------------|
| 1 | High | "IN PROGRESS" status text `text-info` (#6EC4E8) on white = **1.96:1** | 1.4.3 | `CourseCard.jsx:12`, `LearningJourneyBar.jsx:57` |
| 2 | High | "COMPLETED" status text `text-success` (#11A26F) on white = **3.27:1** | 1.4.3 | `CourseCard.jsx:11`, `LearningJourneyBar.jsx:54` |
| 3 | High | Inactive `CourseCard` white text on `neutral-300` (#808080) = **3.95:1** | 1.4.3 | `CourseCard.jsx:70` |
| 4 | Medium | `document.title` never updated — every route is "OCELIA"; no route-change focus/announcement | 2.4.2 | app-wide (0 usages) |
| 5 | Medium | No "skip to main content" link (persistent header + tab bars) | 2.4.1 | app-wide |
| 6 | Medium | Data-table headers lack `scope`; tables have no accessible name/caption | 1.3.1 | `ui/table.jsx:35`, `DataTable.jsx`, `AIMessage.jsx:29` |
| 7 | Medium | Some form errors set `aria-invalid` but aren't linked via `aria-describedby` | 1.3.1 / 3.3.1 | `JoinCourseDialog.jsx` (+ sweep) |
| 8 | Low | Reduced-motion handling inconsistent (spinners, skeleton, progress, caret, auto-scroll) | 2.2.2 / 2.3.3 | see detail |
| 9 | Low | Reusable headings emit fixed levels; possible skips / multiple `<h1>` per page | 1.3.1 / 2.4.6 | `alert.jsx:32`, `card.jsx:24`, layouts |
| 10 | Low | `AnalyticsChart` default `ariaLabel="Line chart"` is generic | 1.1.1 | `AnalyticsChart.jsx` |
| 11 | Latent | `CourseCard` `access_requested` status = `text-white` would be invisible on white card | 1.4.3 | `CourseCard.jsx:13` |

---

## What's already strong

- **Zero `jsx-a11y` violations.** ESLint is thoughtfully configured (documented `no-autofocus` exception for modal/stepped-focus flows; `label-has-associated-control` extended for Radix controls). The only warnings are `react-refresh/only-export-components` (dev-experience, not a11y).
- **Landmarks:** `<main>` in all three layouts; `<nav aria-label>` on every nav (`Admin navigation`, `Course sections`, breadcrumb, instructor tab bar); `<header>` in `AppHeader`. `<html lang="en">` is set.
- **Icon wrapper** (`components/ui/icon.jsx`) is exemplary: decorative by default (`aria-hidden` + `focusable="false"`), opt-in accessible name via `role="img"` + `aria-label`.
- **Live regions:** streaming chat uses `role="log" aria-live="polite"` (`ChatThread`); ~20 loading states use `role="status"` with descriptive `aria-label`; errors/conflicts use `role="alert"` (`Alert`, `ErrorState`, `ConflictWarning`, `RetryBanner`); `OfflineBanner` and `LoadingScreen` announce politely.
- **Labeled icon-only buttons** throughout (Send, New chat, Delete chat, Copy access code, Account menu, Close, Upload files) — 138 `aria-label`s total.
- **Keyboard:** focus-visible rings everywhere via the `ring-ring` token; no positive `tabIndex`; `CourseCard`'s interactive `div` is implemented correctly (`role="button"` + `tabIndex` + Enter/Space handler + `aria-disabled`); delete controls are `focus-visible` (not hover-only); `SessionItem` uses `aria-current`.
- **Forms:** shared `FormField` and the hand-rolled `Login` both wire `htmlFor` + `aria-invalid` + `aria-describedby`; form-level errors render in `role="alert"`; `autoComplete` attributes are correct.
- **Dialogs:** all use Radix (focus trap, Escape, `aria-modal`) and every dialog has a `DialogTitle`, including the full-bleed `CourseWizard` / `EditModule` wizards; the `Close` button is labeled.
- **Other:** `FileUpload` drives a hidden `<input>` from a real labeled button (keyboard path preserved; drag-drop is an enhancement); `ConfirmDialog` conveys destructive meaning via title/label rather than color alone (1.4.1); `AnalyticsChart` is exposed as `role="img"` with a text-parity fallback nearby.

---

## Detailed findings

### High — color contrast (WCAG 1.4.3 AA)

The most concrete failures, on high-traffic screens (student home, chat/course header).

**1. "IN PROGRESS" status label** — `text-info` (#6EC4E8) on the white card background = **1.96:1** (needs 4.5:1).
`components/composed/CourseCard.jsx:12`, repeated in `features/student/LearningJourneyBar.jsx:57`.

**2. "COMPLETED" status label** — `text-success` (#11A26F) on white = **3.27:1** (fails for 14px text).
`components/composed/CourseCard.jsx:11`, repeated in `features/student/LearningJourneyBar.jsx:54`.

**3. Inactive `CourseCard`** — white text on `neutral-300` (#808080) = **3.95:1** (fails for the 14px course name; the larger code text passes).
`components/composed/CourseCard.jsx:70` (`bg-neutral-300 text-white`).

**Fix:** the remedy already exists in the token set. `--info-strong` (#0055B7, ~5:1 on white) was created specifically for "in-progress / processing status text" and is already used at `features/instructor/CourseWizard.jsx:561`. Recommended:
- Status labels → use `text-info-strong` for in-progress; use a darker green (or `success-foreground`-style treatment) for completed text-on-white.
- Inactive card → darker fill or a darker foreground than pure white.

### Medium

**4. Page titles never change (WCAG 2.4.2 Page Titled).** `document.title` is set 0 times; every route renders as "OCELIA" (static in `index.html`). Combined with no focus management on route change, screen-reader and multi-tab users cannot distinguish pages. Add a per-route title (a small effect in `RootLayout` or per-page), and consider moving focus to the page `<h1>`/`<main>` on navigation.

**5. No skip link (WCAG 2.4.1 Bypass Blocks).** There's a persistent `AppHeader` plus tab bars, but no "skip to main content." `<main>` already exists in every layout, so this is a cheap win: a single `sr-only` focusable link at the top of each layout that targets `#main`.

**6. Data tables lack header scope and accessible names (WCAG 1.3.1).** `components/ui/table.jsx:35` renders `<th>` without `scope`, and `DataTable.jsx` sets no `<caption>` or `aria-label`. Affects admin/instructor rosters and any `DataTable` consumer. The chat's structured tables have the same issue (`features/student/chat/AIMessage.jsx:29`; caption rendered as a trailing `<p>` rather than a `<caption>`). Recommended: default `scope="col"` on `TableHead`, and give each `DataTable` a caption/`aria-label`.

**7. A few form errors aren't programmatically linked (WCAG 1.3.1 / 3.3.1).** `JoinCourseDialog` sets `aria-invalid` on the access-code input but renders the error in an unlinked `<p>` (no `id`, no `aria-describedby`), so the message ("That access code isn't valid.") isn't associated with the field. Across the app there are 23 `aria-invalid` vs 15 `aria-describedby`, so a short sweep is warranted. The shared `FormField` (`components/composed/FormField.jsx:23-24`) and `Login` are the correct template to copy.

### Low / polish

**8. Reduced-motion is inconsistent (WCAG 2.2.2 / 2.3.3).** Content animations guard correctly with `motion-reduce:animate-none` (`accordion.jsx`, `collapse.jsx`, `animated-ellipsis.jsx`, `CourseWizard` blink), but these do not:
- `app/LoadingScreen.jsx:17` — spinner (`animate-spin`)
- `components/ui/button.jsx:44` — spinner
- `components/ui/skeleton.jsx:6` — `animate-pulse`
- `features/student/chat/TypingIndicator.jsx:12` — `animate-bounce`
- `features/student/chat/AIMessage.jsx:121` — streaming caret (`animate-pulse`)
- `components/ui/progress.jsx:17` — indeterminate progress

Indeterminate progress and skeletons can run more than 5 seconds. `ChatThread` also auto-scrolls with `behavior: "smooth"` unconditionally. A single global `@media (prefers-reduced-motion: reduce)` rule in `index.css` would cover all of this consistently.

**9. Heading levels are context-independent (WCAG 1.3.1 / 2.4.6).** Reusable primitives emit fixed levels regardless of where they're used: `AlertTitle` → `<h5>` (`alert.jsx:32`, the source of the app's lone `<h5>`), `CardTitle` → `<h3>` (`card.jsx:24`), `EmptyState` → `<h3>`. In addition, a layout and its page can both emit `<h1>` (e.g. `AdminLayout` "Administration" + `CourseDetail`'s `<h1>`). Recommended: a heading-order pass, and consider making these primitives level-configurable (e.g. an `as`/`level` prop).

**10. Chart label default (WCAG 1.1.1).** `AnalyticsChart` defaults `ariaLabel="Line chart"`; verify `InsightsTab` passes a descriptive label. (The component does render numeric text parity nearby, which is the right approach.)

**11. Latent — `access_requested` status color.** `CourseCard` maps `access_requested` to `text-white`, which would be invisible on the default white card (`CourseCard.jsx:13`). It isn't reached today (`StudentCourseCard` only sets `completed`/`in_progress`), but it's a landmine if that status is ever used on a non-inactive card.

---

## Needs manual assistive-technology testing

Static review can't confirm these — they need real AT/keyboard testing:

- **Chat streaming announcements.** `ChatThread` places `aria-live="polite"` on a `role="log"` that wraps the entire conversation. Token-by-token streaming can over- or under-announce depending on the screen reader, and loading or switching a session may dump the full history into the live region. Test with NVDA + VoiceOver; consider announcing only completed messages.
- **Dialog/menu keyboard walkthroughs** and focus-return behavior on close (Radix should handle this, but confirm).
- **Full keyboard-only pass** of each critical flow (login, join course, chat, module create/edit, admin CRUD).

---

## Suggested remediation order

1. **Contrast fixes (High #1–3)** — swap status labels to `text-info-strong` + darker success; darken the inactive card. Small, localized, high impact.
2. **Skip link (#5)** and **per-route `document.title` (#4)** — small, app-wide UX/AT wins.
3. **Table semantics (#6)** — default `scope="col"` + table names.
4. **Form-error association sweep (#7)**.
5. **Global reduced-motion rule (#8)** and **heading-level pass (#9)**.
6. **Manual AT testing** of chat streaming and keyboard flows.

> Per the workspace testing policy, each of these changes should ship with a Vitest/RTL test (e.g. asserting the skip link renders and targets `#main`, that a `DataTable` header carries `scope="col"`, that a route sets its title, that an input's error is referenced by `aria-describedby`).

---

## Appendix — contrast measurements

Computed against `frontend/src/index.css` tokens (white `#ffffff` background unless noted).

| Combination | Ratio | AA (normal / large) |
|---|---|---|
| `foreground` #404040 on white (body) | 10.4:1 | Pass / Pass |
| `muted-foreground` #6e6e6e on white | 5.10:1 | Pass / Pass |
| white on `primary` #6829C2 | 7.82:1 | Pass / Pass |
| `navy` on `info` #6EC4E8 (as `bg-info`) | 8.23:1 | Pass / Pass |
| white on `destructive` #E40000 | 4.89:1 | Pass / Pass |
| `warning-foreground` on `warning` #A88F00 | 5.18:1 | Pass / Pass |
| `border` #808080 on white (non-text) | 3.95:1 | Pass (≥3:1 UI) |
| **`success` #11A26F text on white** | **3.27:1** | **Fail / Pass** |
| **white on `neutral-300` #808080** | **3.95:1** | **Fail / Pass** |
| **`info` #6EC4E8 text on white** | **1.96:1** | **Fail / Fail** |
